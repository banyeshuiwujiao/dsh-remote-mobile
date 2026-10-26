import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { after, before, describe, test } from 'node:test'
import { AccessControl } from '../lib/auth.js'
import { RemoteMobileServer, normalizeConfig } from '../lib/core.js'
import { injectMobileLayer, renderLoginPage, renderStatusPage } from '../lib/mobile.js'
import { isAllowedAddress, normalizeKey, randomToken } from '../lib/util.js'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const HTML = '<!doctype html><html><head><title>Mock DSH</title></head><body><div id="root"></div></body></html>'

/** Minimal upstream that mirrors the DSH auth shape: token -> cookie -> pages. */
function createMockUpstream() {
  const sockets = new Set()
  const state = {
    token: 'test-launch-token',
    sessionValid: true,
    exchanged: 0,
    requests: [],
    upgrades: 0,
  }
  const server = http.createServer((request, response) => {
    state.requests.push({ method: request.method, url: request.url, headers: request.headers })
    const url = new URL(request.url ?? '/', 'http://mock.invalid')
    if (url.pathname === '/' && request.method === 'GET') {
      const tokens = url.searchParams.getAll('token')
      if (tokens.length === 1 && tokens[0] === state.token) {
        state.sessionValid = true
        state.exchanged += 1
        response.writeHead(303, {
          'set-cookie': 'dsh-auth-test=ok; Path=/; HttpOnly; SameSite=Strict',
          location: './',
          'content-length': '0',
        })
        response.end()
        return
      }
      if (request.headers.cookie === 'dsh-auth-test=ok' && state.sessionValid) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(HTML)
        return
      }
      response.writeHead(401)
      response.end('unauthorized')
      return
    }
    if (url.pathname === '/api/echo') {
      if (request.headers.cookie !== 'dsh-auth-test=ok' || !state.sessionValid) {
        response.writeHead(401)
        response.end('unauthorized')
        return
      }
      let body = ''
      request.on('data', (chunk) => {
        body += chunk
      })
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          ok: true,
          method: request.method,
          host: request.headers.host,
          origin: request.headers.origin ?? null,
          cookie: request.headers.cookie ?? null,
          url: request.url,
          body,
        }))
      })
      return
    }
    if (url.pathname === '/assets/app.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' })
      response.end('window.mockApp = 1')
      return
    }
    response.writeHead(404)
    response.end('not found')
  })
  server.on('upgrade', (request, socket) => {
    state.upgrades += 1
    if (request.headers.cookie !== 'dsh-auth-test=ok' || !state.sessionValid) {
      socket.write('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n')
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(String(request.headers['sec-websocket-key']) + WS_GUID).digest('base64')
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'))
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (buffer.length < 2) return
        const first = buffer[0]
        const second = buffer[1]
        const opcode = first & 0x0f
        const masked = (second & 0x80) !== 0
        let length = second & 0x7f
        let offset = 2
        if (length === 126) {
          if (buffer.length < 4) return
          length = buffer.readUInt16BE(2)
          offset = 4
        } else if (length === 127) {
          socket.destroy()
          return
        }
        const maskLength = masked ? 4 : 0
        const total = offset + maskLength + length
        if (buffer.length < total) return
        let payload = Buffer.from(buffer.subarray(offset + maskLength, total))
        if (masked) {
          const mask = buffer.subarray(offset, offset + 4)
          for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4]
        }
        buffer = buffer.subarray(total)
        if (opcode === 8) {
          socket.write(Buffer.from([0x88, 0x00]))
          socket.end()
          return
        }
        if (opcode === 1) {
          socket.write(wsFrame(1, Buffer.concat([Buffer.from('echo:'), payload])))
        }
      }
    })
    socket.on('error', () => socket.destroy())
    socket.on('end', () => socket.destroy())
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  return { server, state, sockets }
}

function wsFrame(opcode, payload) {
  const length = payload.length
  if (length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload])
  if (length < 65536) {
    const header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
    return Buffer.concat([header, payload])
  }
  throw new Error('test frame too large')
}

function maskedFrame(opcode, payload) {
  const mask = randomBytes(4)
  const masked = Buffer.from(payload)
  for (let index = 0; index < masked.length; index++) masked[index] ^= mask[index % 4]
  const length = payload.length
  if (length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | length]), mask, masked])
  const header = Buffer.alloc(4)
  header[0] = 0x80 | opcode
  header[1] = 0x80 | 126
  header.writeUInt16BE(length, 2)
  return Buffer.concat([header, mask, masked])
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function closeServer(server, sockets) {
  return new Promise((resolve) => {
    if (sockets) {
      for (const s of sockets) s.destroy()
      sockets.clear()
    }
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
}

async function startCore(upstreamPort, accessKey = 'TESTKEY123', options = {}) {
  const core = new RemoteMobileServer({
    upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
    launchToken: 'test-launch-token',
    accessKey,
    secret: randomToken(32),
    config: normalizeConfig({
      hosts: ['127.0.0.1'],
      port: 0,
      allowedNetworks: ['127.0.0.0/8'],
      statusFile: '',
      urlFile: '',
      ...options,
    }),
    log: () => {},
  })
  await core.start()
  return core
}

async function login(port, key) {
  const response = await fetch(`http://127.0.0.1:${port}/?key=${encodeURIComponent(key)}`, { redirect: 'manual' })
  const cookies = response.headers.getSetCookie?.() ?? []
  const cookie = cookies[0]?.split(';')[0] ?? ''
  return { response, cookie }
}

function wsRequest(port, cookie, path = '/api/remote.mux') {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const key = randomBytes(16).toString('base64')
      socket.write([
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        `Cookie: ${cookie}`,
        '',
        '',
      ].join('\r\n'))
    })
    let buffer = ''
    const onData = (chunk) => {
      buffer += chunk.toString('latin1')
      if (!buffer.includes('\r\n\r\n')) return
      socket.off('data', onData)
      resolve({ socket, head: buffer })
    }
    socket.on('data', onData)
    socket.on('error', reject)
    socket.setTimeout(5000, () => reject(new Error('ws timeout')))
  })
}

describe('proxy core', () => {
  let mock
  let upstreamPort
  let core

  before(async () => {
    mock = createMockUpstream()
    upstreamPort = await listen(mock.server)
    core = await startCore(upstreamPort)
  })

  after(async () => {
    await core.close()
    await closeServer(mock.server, mock.sockets)
  })

  test('rejects unauthenticated index with the login page', async () => {
    const response = await fetch(`http://127.0.0.1:${core.port}/`, { redirect: 'manual' })
    assert.equal(response.status, 401)
    const text = await response.text()
    assert.match(text, /手机远程访问/)
    assert.match(text, /\/_dsh-mobile\/login/)
  })

  test('rejects a wrong key', async () => {
    const response = await fetch(`http://127.0.0.1:${core.port}/?key=NOPE`, { redirect: 'manual' })
    assert.equal(response.status, 401)
  })

  test('exchanges the access key for a signed cookie', async () => {
    const { response, cookie } = await login(core.port, 'TESTKEY123')
    assert.equal(response.status, 303)
    assert.match(cookie, /^dshm=v1\./)
    const index = await fetch(`http://127.0.0.1:${core.port}/`, { headers: { cookie }, redirect: 'manual' })
    assert.equal(index.status, 200)
    assert.match(await index.text(), /Mock DSH/)
    assert.ok(mock.state.exchanged >= 1)
  })

  test('rewrites Host/Cookie and removes Origin for API calls', async () => {
    const { cookie } = await login(core.port, 'TESTKEY123')
    const response = await fetch(`http://127.0.0.1:${core.port}/api/echo?q=1`, {
      headers: { cookie, origin: `http://127.0.0.1:${core.port}` },
    })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.host, `127.0.0.1:${upstreamPort}`)
    assert.equal(payload.origin, null)
    assert.equal(payload.cookie, 'dsh-auth-test=ok')
    assert.equal(payload.url, '/api/echo?q=1')
  })

  test('streams POST bodies to the upstream', async () => {
    const { cookie } = await login(core.port, 'TESTKEY123')
    const response = await fetch(`http://127.0.0.1:${core.port}/api/echo`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'text/plain' },
      body: 'hello-body',
    })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.method, 'POST')
    assert.equal(payload.body, 'hello-body')
  })

  test('re-mints the upstream cookie after an index 401', async () => {
    const { cookie } = await login(core.port, 'TESTKEY123')
    const before = mock.state.exchanged
    mock.state.sessionValid = false
    const response = await fetch(`http://127.0.0.1:${core.port}/`, { headers: { cookie }, redirect: 'manual' })
    assert.equal(response.status, 200)
    assert.ok(mock.state.exchanged > before)
  })

  test('tunnels the WebSocket upgrade', async () => {
    const { cookie } = await login(core.port, 'TESTKEY123')
    const { socket, head } = await wsRequest(core.port, cookie)
    assert.match(head, /^HTTP\/1\.1 101/u)
    let seen = ''
    const done = new Promise((resolve, reject) => {
      socket.on('data', (chunk) => {
        seen += chunk.toString('latin1')
        if (seen.includes('echo:ping')) resolve()
      })
      socket.setTimeout(5000, () => reject(new Error('echo timeout')))
    })
    socket.write(maskedFrame(1, Buffer.from('ping')))
    await done
    assert.ok(seen.includes('echo:ping'))
    socket.destroy()
  })

  test('rejects a WebSocket without a cookie', async () => {
    const { socket, head } = await wsRequest(core.port, 'dshm=bad')
    assert.match(head, /HTTP\/1\.1 401/u)
    socket.destroy()
  })

  test('serves the injected assets from the plugin', async () => {
    const request = { method: 'GET', url: '/_dsh-mobile/mobile.css' }
    let status = 0
    let body = ''
    const response = {
      writeHead(code) {
        status = code
      },
      end(value) {
        body = Buffer.isBuffer(value) ? value.toString('utf8') : String(value)
      },
    }
    core.serveAsset(request, response)
    assert.equal(status, 200)
    assert.match(body, /dsh-mobile/)
  })

  test('rate-limits repeated wrong keys', async () => {
    const isolated = await startCore(upstreamPort, 'LOCKKEY1234')
    try {
      let last = 0
      for (let index = 0; index < 12; index++) {
        const response = await fetch(`http://127.0.0.1:${isolated.port}/?key=WRONG${index}`, { redirect: 'manual' })
        last = response.status
        if (last === 429) break
      }
      assert.equal(last, 429)
      const blocked = await fetch(`http://127.0.0.1:${isolated.port}/?key=LOCKKEY1234`, { redirect: 'manual' })
      assert.equal(blocked.status, 429)
    } finally {
      await isolated.close()
    }
  })
})

describe('mobile layer', () => {
  test('injects the stylesheet, script, and PWA meta', () => {
    const out = injectMobileLayer(HTML, { version: '1.2.3' })
    assert.match(out, /data-dsh-mobile-layer/)
    assert.match(out, /\/_dsh-mobile\/mobile\.css\?v=1\.2\.3/)
    assert.match(out, /\/_dsh-mobile\/mobile\.js\?v=1\.2\.3/)
    assert.match(out, /apple-mobile-web-app-capable/)
    assert.equal(injectMobileLayer(out, { version: '1.2.3' }), out)
  })

  test('uses relative cleanup for desktop/mobile query flags', () => {
    const out = injectMobileLayer(HTML, { version: 'x' })
    assert.match(out, /dsh-mobile-off/)
    assert.match(out, /desktop=1/)
  })

  test('renders a login page with escaped host text', () => {
    const page = renderLoginPage({ host: '<script>alert(1)</script>', address: '100.64.0.2' })
    assert.doesNotMatch(page, /<script>alert\(1\)<\/script>/)
    assert.match(page, /&lt;script&gt;/)
    assert.match(page, /100\.64\.0\.2/)
  })

  test('renders a status page', () => {
    const page = renderStatusPage({
      version: '0.1.0',
      hosts: ['100.64.0.2'],
      port: 8788,
      urls: ['http://100.64.0.2:8788/?key=ABC'],
      upstream: { origin: 'http://127.0.0.1:1', cookieAgeSeconds: 12, lastLoginAt: null },
      requests: 3,
      clients: ['100.64.0.3'],
      startedAt: '2026-01-01T00:00:00Z',
    })
    assert.match(page, /DSH 手机远程/)
    assert.match(page, /http:\/\/100\.64\.0\.2:8788/)
  })
})

describe('addressing and keys', () => {
  test('allows Tailscale and loopback, rejects LAN by default', () => {
    const networks = ['100.64.0.0/10', '127.0.0.0/8', '::1/128']
    assert.equal(isAllowedAddress('100.68.50.93', networks), true)
    assert.equal(isAllowedAddress('127.0.0.1', networks), true)
    assert.equal(isAllowedAddress('::ffff:127.0.0.1', networks), true)
    assert.equal(isAllowedAddress('::1', networks), true)
    assert.equal(isAllowedAddress('10.25.99.212', networks), false)
  })

  test('normalizes typed keys', () => {
    assert.equal(normalizeKey(' ab-cd 12 '), 'ABCD12')
  })

  test('cookie is authority-bound and expires', () => {
    const access = new AccessControl({
      accessKey: 'ABCD2345',
      secret: randomToken(32),
      allowedNetworks: ['127.0.0.0/8'],
      cookieMaxAgeDays: 1,
    })
    const request = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '100.64.0.2:8788' } }
    assert.equal(access.verifyKey(request, 'ABCD2345').ok, true)
    const cookie = access.sessionCookie(request).split(';')[0]
    assert.equal(access.isAuthenticated({ headers: { host: '100.64.0.2:8788', cookie } }), true)
    assert.equal(access.isAuthenticated({ headers: { host: '100.64.0.3:8788', cookie } }), false)
    assert.equal(access.isAuthenticated({ headers: { host: '100.64.0.2:8788', cookie: 'dshm=v1.1.bad' } }), false)
  })
})

describe('anonymous access (allowAnonymous)', () => {
  let mock
  let upstreamPort
  let core

  before(async () => {
    mock = createMockUpstream()
    upstreamPort = await listen(mock.server)
    core = await startCore(upstreamPort, '', { allowAnonymous: true })
  })

  after(async () => {
    await core.close()
    await closeServer(mock.server, mock.sockets)
  })

  test('admits an allowed peer with no key and no cookie', async () => {
    const response = await fetch(`http://127.0.0.1:${core.port}/`, { redirect: 'manual' })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /Mock DSH/)
  })

  test('does not mint a session cookie', async () => {
    const response = await fetch(`http://127.0.0.1:${core.port}/`, { redirect: 'manual' })
    assert.equal((response.headers.getSetCookie?.() ?? []).length, 0)
  })

  test('a wrong key in the query no longer denies', async () => {
    const response = await fetch(`http://127.0.0.1:${core.port}/?key=WRONGKEY`, { redirect: 'manual' })
    assert.equal(response.status, 200)
  })

  test('status is readable without a cookie', async () => {
    const response = await fetch(`http://127.0.0.1:${core.port}/_dsh-mobile/status`)
    assert.equal(response.status, 200)
  })

  test('advertises URLs without a key', () => {
    const urls = core.getUrls()
    assert.ok(urls.length > 0)
    for (const url of urls) assert.doesNotMatch(url, /key=/)
  })

  test('the network fence is independent of the auth flag', () => {
    // allowAnonymous 只关掉第二道门（密钥/cookie）；peer 地址不在
    // allowedNetworks 里仍然必须被拒，否则这个开关等于把门整个拆了。
    assert.equal(core.config.allowAnonymous, true)
    assert.equal(core.access.admitsPeer({ socket: { remoteAddress: '10.25.99.212' } }), false)
    assert.equal(core.access.admitsPeer({ socket: { remoteAddress: '127.0.0.1' } }), true)
  })
})
