/**
 * dsh-remote-mobile — phone-facing reverse proxy.
 *
 * Why a proxy instead of rebinding the Harness web server:
 *   · `dsh-host-webserver` deliberately refuses wildcard binds and this
 *     Desktop build hardcodes `127.0.0.1` for its own window URL.
 *   · The Harness browser cookie is bound to that loopback authority. A phone
 *     on Tailscale cannot present it, so the proxy performs the launch-token
 *     exchange server-side and keeps the upstream cookie in memory.
 *   · The proxy adds its own access key, peer allow list, and a mobile layer
 *     without changing the desktop's own transport.
 *
 * Everything is Node built-ins only.
 */
import http from 'node:http'
import https from 'node:https'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AccessControl } from './auth.js'
import { renderLoginPage, renderStatusPage } from './mobile.js'
import { writeAtomic } from './state.js'
import {
  VERSION,
  authority,
  detectTailscaleHint,
  normalizeKey,
  parseNetworkList,
  sleep,
  urlHost,
} from './util.js'

const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')
const ASSET_TYPES = new Map([
  ['/_dsh-mobile/mobile.css', ['mobile.css', 'text/css; charset=utf-8']],
  ['/_dsh-mobile/mobile.js', ['mobile.js', 'text/javascript; charset=utf-8']],
  ['/_dsh-mobile/icon.svg', ['icon.svg', 'image/svg+xml']],
])
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'origin',
  'referer',
  'cookie',
  'expect',
])
const DEFAULT_ALLOWED = ['100.64.0.0/10', '127.0.0.0/8', '::1/128']
const LOGIN_PATH = '/_dsh-mobile/login'
const LOGOUT_PATH = '/_dsh-mobile/logout'
const STATUS_PATH = '/_dsh-mobile/status'
const MAX_LOGIN_BODY = 8 * 1024

function wantsJson(request) {
  const accept = String(request.headers.accept ?? '')
  return accept.includes('application/json')
}

function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/') || pathname.startsWith('/_dsh-mobile/')
}

/** Read a bounded request body as UTF-8. */
function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('request body too large'), { code: 'ETOOLARGE' }))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/** Write a small text/JSON response. */
function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body))
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(payload)
}

function sendJson(res, status, value, headers = {}) {
  send(res, status, `${JSON.stringify(value)}\n`, {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  })
}

/** Redirect preserving the response lifecycle. */
function redirect(res, location, status = 303) {
  res.writeHead(status, {
    location,
    'cache-control': 'no-store',
    'content-length': '0',
  })
  res.end()
}

/** Read an upstream response up to a bound, then discard the rest. */
async function readUpstream(response, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of response) {
    if (size < limit) {
      chunks.push(chunk)
      size += chunk.length
    }
  }
  return Buffer.concat(chunks).subarray(0, limit).toString('utf8')
}

/** Pick the socket wrapper for a URL protocol. */
function transportFor(protocol) {
  return protocol === 'https:' ? https : http
}

/**
 * Normalize the plugin configuration into one immutable object.
 * @param {object} input
 * @returns {object}
 */
export function normalizeConfig(input = {}) {
  const hosts = Array.isArray(input.hosts) ? input.hosts.map(String).filter(Boolean) : []
  const port = Number(input.port ?? 8788)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('remote-mobile: port must be an integer 0..65535')
  const tls = input.tls && typeof input.tls === 'object'
    ? { certFile: String(input.tls.certFile ?? ''), keyFile: String(input.tls.keyFile ?? '') }
    : { certFile: '', keyFile: '' }
  if ((tls.certFile === '') !== (tls.keyFile === '')) throw new Error('remote-mobile: tls.certFile and tls.keyFile must be supplied together')
  return {
    port,
    hosts,
    accessKey: input.accessKey === undefined ? '' : String(input.accessKey),
    cookieMaxAgeDays: Math.max(1, Number(input.cookieMaxAgeDays ?? 30)),
    allowedNetworks: parseNetworkList(input.allowedNetworks) ?? [...DEFAULT_ALLOWED],
    maxLoginFailures: Math.max(1, Number(input.maxLoginFailures ?? 8)),
    lockoutMs: Math.max(1000, Number(input.lockoutMs ?? 5 * 60 * 1000)),
    mobileLayer: input.mobileLayer !== false,
    allowAnonymous: input.allowAnonymous === true,
    publicUrl: input.publicUrl === undefined ? '' : String(input.publicUrl).replace(/\/+$/u, ''),
    tls,
    trustProxy: input.trustProxy === true,
    logRequests: input.logRequests === true,
    upstreamTimeoutMs: Math.max(1000, Number(input.upstreamTimeoutMs ?? 30000)),
    wsTimeoutMs: Math.max(1000, Number(input.wsTimeoutMs ?? 15000)),
    cookieRefreshMs: Math.max(60_000, Number(input.cookieRefreshMs ?? 6 * 60 * 60 * 1000)),
    statusFile: input.statusFile ? String(input.statusFile) : '',
    urlFile: input.urlFile ? String(input.urlFile) : '',
  }
}

/** The phone-facing server. */
export class RemoteMobileServer {
  /**
   * @param {object} options
   * @param {string} options.upstreamOrigin - e.g. `http://127.0.0.1:61153`.
   * @param {string} options.launchToken - this process's DSH launch token.
   * @param {string} options.accessKey - phone access key.
   * @param {string} options.secret - cookie-signing secret.
   * @param {object} [options.config] - normalized configuration.
   * @param {(level: string, message: string) => void} [options.log]
   */
  constructor(options) {
    this.config = options.config ?? normalizeConfig(options)
    this.upstreamOrigin = String(options.upstreamOrigin).replace(/\/+$/u, '')
    const upstreamUrl = new URL(this.upstreamOrigin)
    if (upstreamUrl.protocol !== 'http:' && upstreamUrl.protocol !== 'https:') {
      throw new Error('remote-mobile: upstreamOrigin must be http(s)')
    }
    this.upstream = upstreamUrl
    this.upstreamAuthority = upstreamUrl.host
    this.launchToken = String(options.launchToken ?? '')
    this.log = typeof options.log === 'function' ? options.log : () => {}
    this.access = new AccessControl({
      accessKey: options.accessKey,
      secret: options.secret,
      cookieMaxAgeDays: this.config.cookieMaxAgeDays,
      allowedNetworks: this.config.allowedNetworks,
      tls: this.config.tls.certFile !== '',
      trustProxy: this.config.trustProxy,
      maxFailures: this.config.maxLoginFailures,
      lockMs: this.config.lockoutMs,
    })
    this.started = false
    this.startedAt = null
    this.port = this.config.port
    this.listeners = []
    this.openSockets = new Set()
    this.httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 })
    this.httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16 })
    this.upstreamCookie = null
    this.upstreamCookieAt = 0
    this.upstreamLastLoginAt = null
    this.loginPromise = null
    this.requestHandler = this.handleRequest.bind(this)
    this.upgradeHandler = this.handleUpgrade.bind(this)
    this.stats = {
      requests: 0,
      logins: 0,
      failures: 0,
      lastRequestAt: null,
      clients: new Set(),
    }
  }

  /** Whether the listener terminates TLS. */
  get tls() {
    return this.config.tls.certFile !== ''
  }

  /** Effective scheme. */
  get protocol() {
    return this.tls ? 'https:' : 'http:'
  }

  /** Start every configured listener. Throws when no listener binds. */
  async start() {
    if (this.started) return this
    const hosts = this.config.hosts.length > 0 ? this.config.hosts : ['127.0.0.1']
    const errors = []
    let firstPort = this.config.port
    let tlsOptions
    if (this.tls) {
      tlsOptions = {
        cert: readFileSync(this.config.tls.certFile),
        key: readFileSync(this.config.tls.keyFile),
      }
    }
    for (const host of hosts) {
      const server = this.tls
        ? https.createServer(tlsOptions, this.requestHandler)
        : http.createServer(this.requestHandler)
      server.on('upgrade', this.upgradeHandler)
      server.on('clientError', (error, socket) => {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
        this.log('debug', `client error: ${error.message}`)
      })
      server.on('connection', (socket) => {
        this.openSockets.add(socket)
        socket.on('close', () => this.openSockets.delete(socket))
      })
      try {
        const actualPort = await this.listen(server, host, firstPort)
        if (firstPort === 0) firstPort = actualPort
        this.port = actualPort
        this.listeners.push({ server, host, port: actualPort })
        this.log('info', `listening on ${this.protocol}//${urlHost(host)}:${String(actualPort)}`)
      } catch (error) {
        errors.push(`${host}: ${error instanceof Error ? error.message : String(error)}`)
        server.close()
      }
    }
    if (this.listeners.length === 0) {
      throw new Error(`remote-mobile: no listener could bind (${errors.join('; ') || 'no hosts'})`)
    }
    this.started = true
    this.startedAt = new Date().toISOString()
    this.writeStatusFile()
    return this
  }

  /** Promise wrapper around `server.listen`. */
  listen(server, host, port) {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        const address = server.address()
        resolve(typeof address === 'object' && address !== null ? address.port : port)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    })
  }

  /** Stop listeners and every proxied socket. */
  async close() {
    if (!this.started) return
    this.started = false
    this.writeStatusFile()
    for (const entry of this.listeners) {
      try {
        entry.server.close()
        entry.server.closeAllConnections?.()
      } catch {
        /* already closed */
      }
    }
    for (const socket of this.openSockets) {
      try {
        socket.destroy()
      } catch {
        /* already gone */
      }
    }
    this.openSockets.clear()
    this.listeners = []
    this.httpAgent.destroy()
    this.httpsAgent.destroy()
    await sleep(20)
    this.writeStatusFile()
  }

  /** URLs the phone can open, key included unless anonymous access is on. */
  getUrls() {
    const key = this.config.allowAnonymous ? '' : `?key=${encodeURIComponent(this.access.accessKey)}`
    if (this.config.publicUrl !== '') {
      const base = `${this.config.publicUrl}/`
      return [key === '' ? base : `${base}${key}`]
    }
    const out = []
    for (const entry of this.listeners) {
      let host = entry.host
      if (host === '0.0.0.0' || host === '::') {
        host = detectTailscaleHint() ?? '127.0.0.1'
      }
      const scheme = this.tls ? 'https' : 'http'
      out.push(`${scheme}://${authority(host, entry.port)}/${key}`)
    }
    return out
  }

  /** Live status (safe for the authenticated phone status page). */
  getStatus() {
    return {
      name: 'dsh-remote-mobile',
      version: VERSION,
      running: this.started,
      startedAt: this.startedAt,
      port: this.port,
      hosts: this.listeners.map((entry) => entry.host),
      urls: this.getUrls(),
      publicUrl: this.config.publicUrl || null,
      mobileLayer: this.config.mobileLayer,
      upstream: {
        origin: this.upstreamOrigin,
        cookieAgeSeconds: this.upstreamCookieAt === 0 ? null : Math.round((Date.now() - this.upstreamCookieAt) / 1000),
        lastLoginAt: this.upstreamLastLoginAt,
      },
      requests: this.stats.requests,
      logins: this.stats.logins,
      failures: this.stats.failures,
      lastRequestAt: this.stats.lastRequestAt,
      clients: [...this.stats.clients].sort(),
      allowedNetworks: this.config.allowedNetworks,
    }
  }

  /** Persist a status snapshot for the desktop-side operator. */
  writeStatusFile() {
    const status = this.getStatus()
    if (this.config.statusFile !== '') {
      try {
        writeAtomic(this.config.statusFile, `${JSON.stringify(status, null, 2)}\n`)
      } catch (error) {
        this.log('warn', `could not write status file: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (this.config.urlFile !== '' && status.urls.length > 0) {
      try {
        writeAtomic(this.config.urlFile, `${status.urls.join('\n')}\n`)
      } catch (error) {
        this.log('warn', `could not write URL file: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** Rotate the access key; existing cookies stay valid until expiry. */
  rotateKey(nextKey) {
    this.access.accessKey = normalizeKey(nextKey)
    this.writeStatusFile()
    return this.access.accessKey
  }

  /** Serve one of the injected mobile assets from the plugin directory. */
  serveAsset(request, response) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(response, 405, 'method not allowed')
      return
    }
    const pathname = new URL(request.url ?? '/', 'http://local').pathname
    const entry = ASSET_TYPES.get(pathname)
    if (entry === undefined) {
      send(response, 404, 'not found')
      return
    }
    try {
      const body = readFileSync(join(ASSETS_DIR, entry[0]))
      response.writeHead(200, {
        'content-type': entry[1],
        'content-length': String(body.length),
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      })
      response.end(body)
    } catch (error) {
      this.log('warn', `missing asset ${entry[0]}: ${error instanceof Error ? error.message : String(error)}`)
      send(response, 404, 'not found')
    }
  }

  /** Main HTTP dispatch. */
  async handleRequest(request, response) {
    try {
      this.stats.requests += 1
      this.stats.lastRequestAt = new Date().toISOString()
      const peer = this.access.peerAddress(request)
      this.stats.clients.add(peer)
      if (!this.access.admitsPeer(request)) {
        this.log('warn', `rejected peer ${peer || '(unknown)'}`)
        send(response, 403, 'peer is outside the allowed networks')
        return
      }
      if (this.config.logRequests) this.log('debug', `${request.method} ${request.url}`)
      const url = new URL(request.url ?? '/', 'http://dsh-mobile.invalid')
      if (url.pathname === LOGIN_PATH) {
        await this.handleLogin(request, response, url)
        return
      }
      if (url.pathname === LOGOUT_PATH) {
        response.writeHead(303, {
          'set-cookie': this.access.clearCookie(request),
          location: LOGIN_PATH,
          'cache-control': 'no-store',
          'content-length': '0',
        })
        response.end()
        return
      }
      if (url.pathname === STATUS_PATH) {
        await this.handleStatus(request, response, url)
        return
      }
      if (ASSET_TYPES.has(url.pathname)) {
        this.serveAsset(request, response)
        return
      }
      const credential = this.access.credentialFrom(request, url)
      if (credential !== undefined && !this.config.allowAnonymous) {
        const result = this.access.verifyKey(request, credential.key)
        if (!result.ok) {
          this.stats.failures += 1
          this.deny(request, response, url, result)
          return
        }
        this.stats.logins += 1
        this.log('info', `login from ${participant(result.address)}`)
        url.searchParams.delete('key')
        const target = `${url.pathname}${url.search}${url.hash}`
        response.writeHead(303, {
          'set-cookie': this.access.sessionCookie(request),
          location: target === '' ? '/' : target,
          'cache-control': 'no-store',
          'content-length': '0',
        })
        response.end()
        return
      }
      if (!this.config.allowAnonymous && !this.access.isAuthenticated(request)) {
        this.deny(request, response, url, { ok: false, reason: 'invalid', address: peer })
        return
      }
      await this.proxyHttp(request, response, true)
    } catch (error) {
      this.log('error', `request failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      if (!response.headersSent) send(response, 500, 'internal error')
      else response.destroy()
    }
  }

  /** 401/403/429 response with the right representation. */
  deny(request, response, url, result) {
    const status = result.reason === 'locked' ? 429 : 401
    const headers = {}
    if (typeof result.retryAfterMs === 'number') {
      headers['retry-after'] = String(Math.max(1, Math.ceil(result.retryAfterMs / 1000)))
    }
    if (wantsJson(request) || isApiPath(url.pathname)) {
      sendJson(response, status, { error: status === 429 ? 'too_many_attempts' : 'unauthorized' }, headers)
      return
    }
    const host = String(request.headers.host ?? '')
    const address = this.access.peerAddress(request)
    const message = result.reason === 'locked'
      ? '尝试次数过多，已暂时锁定。'
      : result.reason === 'invalid' && typeof result.remaining === 'number'
        ? `密钥不正确，还可尝试 ${result.remaining} 次。`
        : '请输入访问密钥。'
    const html = renderLoginPage({
      error: message,
      lockedUntil: status === 429 ? Date.now() + (result.retryAfterMs ?? this.config.lockoutMs) : undefined,
      host,
      address,
      version: VERSION,
    })
    send(response, status, html, { 'content-type': 'text/html; charset=utf-8', ...headers })
  }

  /** GET/POST key entry. */
  async handleLogin(request, response, url) {
    if (request.method === 'GET') {
      const host = String(request.headers.host ?? '')
      const address = this.access.peerAddress(request)
      send(response, 200, renderLoginPage({ host, address, version: VERSION }), {
        'content-type': 'text/html; charset=utf-8',
      })
      return
    }
    if (request.method !== 'POST') {
      send(response, 405, 'method not allowed', { allow: 'GET, POST' })
      return
    }
    const peer = this.access.peerAddress(request)
    if (this.access.isLocked(peer)) {
      const row = this.access.failures.get(peer)
      this.deny(request, response, url, { ok: false, reason: 'locked', address: peer, retryAfterMs: Math.max(0, (row?.lockedUntil ?? 0) - Date.now()) })
      return
    }
    let body = ''
    try {
      body = await readBody(request, MAX_LOGIN_BODY)
    } catch (error) {
      send(response, 413, 'request body too large')
      return
    }
    let key = ''
    const type = String(request.headers['content-type'] ?? '')
    try {
      if (type.includes('application/json')) key = String(JSON.parse(body)?.key ?? '')
      else key = String(new URLSearchParams(body).get('key') ?? '')
    } catch {
      key = ''
    }
    const result = this.access.verifyKey(request, key)
    if (!result.ok) {
      this.stats.failures += 1
      this.log('warn', `failed login from ${participant(result.address)}`)
      this.deny(request, response, url, result)
      return
    }
    this.stats.logins += 1
    this.log('info', `login from ${participant(result.address)}`)
    response.writeHead(303, {
      'set-cookie': this.access.sessionCookie(request),
      location: '/',
      'cache-control': 'no-store',
      'content-length': '0',
    })
    response.end()
  }

  /** Authenticated status representation. */
  async handleStatus(request, response, url) {
    if (!this.config.allowAnonymous && !this.access.isAuthenticated(request)) {
      this.deny(request, response, url, { ok: false, reason: 'invalid', address: this.access.peerAddress(request) })
      return
    }
    const status = this.getStatus()
    if (url.searchParams.get('format') === 'html' || String(request.headers.accept ?? '').includes('text/html')) {
      send(response, 200, renderStatusPage(status), { 'content-type': 'text/html; charset=utf-8' })
      return
    }
    sendJson(response, 200, status)
  }

  /** Headers sent to the upstream Host. */
  forwardHeaders(request) {
    const out = {}
    for (const [name, value] of Object.entries(request.headers)) {
      const key = name.toLowerCase()
      if (value === undefined) continue
      if (HOP_BY_HOP.has(key)) continue
      if (key.startsWith('x-forwarded-') || key === 'forwarded') continue
      out[key] = value
    }
    out.host = this.upstreamAuthority
    if (this.upstreamCookie !== null) out.cookie = this.upstreamCookie
    return out
  }

  /** Ensure a fresh upstream browser cookie, performing the token exchange once. */
  ensureUpstream(force = false) {
    if (!force && this.upstreamCookie !== null && Date.now() - this.upstreamCookieAt < this.config.cookieRefreshMs) {
      return Promise.resolve({ ok: true })
    }
    if (this.loginPromise !== null) return this.loginPromise
    this.loginPromise = this.loginUpstream().finally(() => {
      this.loginPromise = null
    })
    return this.loginPromise
  }

  /** Exchange the launch token for the signed browser cookie the upstream expects. */
  async loginUpstream() {
    if (this.launchToken === '') return { ok: false, error: 'launch token is unavailable' }
    const exchange = await this.upstreamRequest('GET', `/?token=${encodeURIComponent(this.launchToken)}`, {
      host: this.upstreamAuthority,
      'accept-encoding': 'identity',
    })
    if (exchange.status !== 303) {
      return { ok: false, error: `token exchange returned HTTP ${String(exchange.status)}` }
    }
    const cookies = exchange.headers['set-cookie']
    const list = Array.isArray(cookies) ? cookies : cookies === undefined ? [] : [cookies]
    const cookie = list.find((value) => value.startsWith('dsh-auth-'))
    if (cookie === undefined) return { ok: false, error: 'token exchange returned no dsh-auth cookie' }
    const pair = cookie.split(';')[0]
    const verify = await this.upstreamRequest('GET', '/', {
      host: this.upstreamAuthority,
      cookie: pair,
      'accept-encoding': 'identity',
    })
    if (verify.status !== 200) {
      return { ok: false, error: `upstream cookie verification returned HTTP ${String(verify.status)}` }
    }
    this.upstreamCookie = pair
    this.upstreamCookieAt = Date.now()
    this.upstreamLastLoginAt = new Date().toISOString()
    this.log('info', 'minted upstream browser cookie')
    return { ok: true }
  }

  /** One buffered upstream request used only by the login handshake. */
  upstreamRequest(method, path, headers) {
    return new Promise((resolve, reject) => {
      const transport = transportFor(this.upstream.protocol)
      const request = transport.request({
        protocol: this.upstream.protocol,
        hostname: this.upstream.hostname,
        port: this.upstream.port,
        method,
        path,
        headers,
        agent: false,
        timeout: this.config.upstreamTimeoutMs,
      }, async (response) => {
        try {
          const body = await readUpstream(response)
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body })
        } catch (error) {
          reject(error)
        }
      })
      request.on('timeout', () => request.destroy(new Error('upstream timeout')))
      request.on('error', reject)
      request.end()
    })
  }

  /** Proxy one HTTP request, optionally retrying the index after a 401. */
  async proxyHttp(request, response, allowRetry) {
    const ready = await this.ensureUpstream(false)
    if (!ready.ok) {
      this.log('error', `upstream login failed: ${ready.error}`)
      if (isApiPath(new URL(request.url ?? '/', 'http://x').pathname) || wantsJson(request)) {
        sendJson(response, 502, { error: 'upstream_unavailable' })
      } else {
        send(response, 502, `DSH upstream is not reachable: ${ready.error}`)
      }
      return
    }
    const transport = transportFor(this.upstream.protocol)
    const headers = this.forwardHeaders(request)
    const requestOptions = {
      protocol: this.upstream.protocol,
      hostname: this.upstream.hostname,
      port: this.upstream.port,
      method: request.method,
      path: request.url,
      headers,
      agent: transport === https ? this.httpsAgent : this.httpAgent,
      timeout: this.config.upstreamTimeoutMs,
    }
    const upstreamRequest = transport.request(requestOptions, (upstreamResponse) => {
      const pathname = new URL(request.url ?? '/', 'http://x').pathname
      const isIndex = pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')
      if (upstreamResponse.statusCode === 401 || upstreamResponse.statusCode === 403) {
        upstreamResponse.resume()
        this.upstreamCookie = null
        this.upstreamCookieAt = 0
        if (allowRetry && isIndex && upstreamResponse.statusCode === 401) {
          this.log('warn', 'upstream rejected the cached cookie; re-authenticating')
          this.proxyHttp(request, response, false).catch((error) => {
            this.log('error', `retry failed: ${error instanceof Error ? error.message : String(error)}`)
            if (!response.headersSent) send(response, 502, 'upstream retry failed')
            else response.destroy()
          })
          return
        }
        send(response, upstreamResponse.statusCode === 403 ? 403 : 401, 'unauthorized')
        return
      }
      const outHeaders = { ...upstreamResponse.headers }
      delete outHeaders['set-cookie']
      delete outHeaders.connection
      delete outHeaders['keep-alive']
      delete outHeaders['transfer-encoding']
      delete outHeaders.upgrade
      if (typeof outHeaders.location === 'string' && outHeaders.location.startsWith(this.upstreamOrigin)) {
        outHeaders.location = outHeaders.location.slice(this.upstreamOrigin.length) || '/'
      }
      if (String(outHeaders['content-type'] ?? '').includes('text/html')) outHeaders['cache-control'] = 'no-store'
      response.writeHead(upstreamResponse.statusCode ?? 502, outHeaders)
      upstreamResponse.pipe(response)
      upstreamResponse.on('error', () => response.destroy())
      response.on('close', () => upstreamResponse.destroy())
    })
    upstreamRequest.on('timeout', () => upstreamRequest.destroy(new Error('upstream timeout')))
    upstreamRequest.on('error', (error) => {
      this.log('warn', `upstream error: ${error.message}`)
      if (!response.headersSent) {
        if (wantsJson(request)) sendJson(response, 502, { error: 'upstream_unavailable' })
        else send(response, 502, 'upstream unavailable')
      } else {
        response.destroy()
      }
    })
    request.on('aborted', () => upstreamRequest.destroy())
    if (request.readableEnded) upstreamRequest.end()
    else request.pipe(upstreamRequest)
  }

  /** HTTP upgrade dispatch for the RPC multiplexer. */
  async handleUpgrade(request, socket, head) {
    try {
      const peer = this.access.peerAddress(request)
      if (!this.access.admitsPeer(request)) {
        this.rejectUpgrade(socket, 403, 'peer is outside the allowed networks')
        return
      }
      const url = new URL(request.url ?? '/', 'http://x')
      if (url.pathname.startsWith('/_dsh-mobile/')) {
        this.rejectUpgrade(socket, 404, 'not found')
        return
      }
      if (!this.config.allowAnonymous && !this.access.isAuthenticated(request)) {
        this.rejectUpgrade(socket, 401, 'unauthorized')
        return
      }
      this.stats.clients.add(peer)
      const ready = await this.ensureUpstream(false)
      if (!ready.ok) {
        this.rejectUpgrade(socket, 502, 'upstream unavailable')
        return
      }
      this.openUpstreamSocket(request, socket, head, 0)
    } catch (error) {
      this.log('error', `upgrade failed: ${error instanceof Error ? error.message : String(error)}`)
      this.rejectUpgrade(socket, 500, 'internal error')
    }
  }

  /** Write a minimal rejection and close the socket. */
  rejectUpgrade(socket, status, message) {
    if (socket.destroyed) return
    const body = String(message)
    const lines = [
      `HTTP/1.1 ${String(status)} ${http.STATUS_CODES[status] ?? 'Error'}`,
      'connection: close',
      'content-type: text/plain; charset=utf-8',
      `content-length: ${String(Buffer.byteLength(body))}`,
      '',
      body,
    ]
    try {
      socket.write(lines.join('\r\n'))
    } catch {
      /* peer already gone */
    }
    socket.destroy()
  }

  /** Establish the upstream WebSocket and splice both sockets. */
  openUpstreamSocket(request, socket, head, attempt) {
    const headers = this.forwardHeaders(request)
    headers.connection = 'Upgrade'
    headers.upgrade = 'websocket'
    const transport = transportFor(this.upstream.protocol)
    const upstreamRequest = transport.request({
      protocol: this.upstream.protocol,
      hostname: this.upstream.hostname,
      port: this.upstream.port,
      method: 'GET',
      path: request.url,
      headers,
      agent: false,
      timeout: this.config.wsTimeoutMs,
    })
    upstreamRequest.on('timeout', () => upstreamRequest.destroy(new Error('websocket handshake timeout')))
    upstreamRequest.on('error', (error) => {
      this.log('warn', `websocket upstream error: ${error.message}`)
      this.rejectUpgrade(socket, 502, 'upstream websocket unavailable')
    })
    upstreamRequest.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      const raw = [`HTTP/1.1 101 Switching Protocols`]
      for (let index = 0; index < upstreamResponse.rawHeaders.length; index += 2) {
        raw.push(`${upstreamResponse.rawHeaders[index]}: ${upstreamResponse.rawHeaders[index + 1]}`)
      }
      raw.push('', '')
      try {
        socket.write(raw.join('\r\n'))
        if (upstreamHead !== undefined && upstreamHead.length > 0) socket.write(upstreamHead)
        if (head !== undefined && head.length > 0) upstreamSocket.write(head)
      } catch (error) {
        upstreamSocket.destroy()
        socket.destroy()
        this.log('warn', `websocket splice failed: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      upstreamSocket.setNoDelay?.(true)
      socket.setNoDelay?.(true)
      this.openSockets.add(socket)
      this.openSockets.add(upstreamSocket)
      const cleanup = () => {
        try {
          upstreamSocket.destroy()
        } catch {
          /* already gone */
        }
        try {
          socket.destroy()
        } catch {
          /* already gone */
        }
        this.openSockets.delete(upstreamSocket)
        this.openSockets.delete(socket)
      }
      upstreamSocket.on('error', cleanup)
      socket.on('error', cleanup)
      upstreamSocket.on('close', cleanup)
      socket.on('close', cleanup)
      upstreamSocket.pipe(socket)
      socket.pipe(upstreamSocket)
    })
    upstreamRequest.on('response', async (upstreamResponse) => {
      upstreamResponse.resume()
      if (upstreamResponse.statusCode === 401 && attempt === 0) {
        this.upstreamCookie = null
        this.upstreamCookieAt = 0
        const ready = await this.ensureUpstream(true)
        if (ready.ok) {
          this.openUpstreamSocket(request, socket, head, 1)
          return
        }
      }
      this.rejectUpgrade(socket, upstreamResponse.statusCode ?? 502, 'upstream refused the websocket')
    })
    upstreamRequest.end()
  }
}

/** Wrap a peer address for logs without ever printing a full identifier. */
function participant(address) {
  const text = String(address ?? '')
  if (text.includes(':')) return text
  return text.replace(/\.(\d+)$/u, '.x')
}
