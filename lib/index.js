/**
 * dsh-remote-mobile — Cordis host plugin.
 *
 * Mounts a phone-facing listener beside the Desktop's loopback web server,
 * taps the upstream index once to add the mobile layer, and serves the small
 * injected assets from this package. The Desktop UI itself is proxied
 * unchanged, so every existing feature (sessions, approvals, terminals, tool
 * cards) works from the phone.
 *
 * Row config (all optional):
 *   enabled          boolean  default true
 *   port             number   default 8788 (0 = OS-assigned, for tests)
 *   bind             string   auto | tailscale | loopback | lan | <IPv4 literal>
 *   hosts            string[] explicit bind addresses; wins over `bind`
 *   accessKey        string   empty = generate and persist (10 chars)
 *   stateFile        string   default $DSH_HOME/remote-mobile/state.json
 *   statusFile       string   default $DSH_HOME/remote-mobile/status.json
 *   urlFile          string   default $DSH_HOME/remote-mobile/url.txt
 *   allowedNetworks  string[] default ['100.64.0.0/10','127.0.0.0/8','::1/128']
 *   mobileLayer      boolean  default true
 *   publicUrl        string   advertised root (e.g. https://host.tailnet.ts.net)
 *   trustProxy       boolean  honor X-Forwarded-Proto for Secure cookies
 *   tls.certFile     string   PEM chain (both TLS fields or neither)
 *   tls.keyFile      string   PEM key
 *   cookieMaxAgeDays number   default 30
 *   maxLoginFailures number   default 8
 *   lockoutMs        number   default 300000
 *   logRequests      boolean  default false
 */
import { isIP } from 'node:net'
import { RemoteMobileServer, normalizeConfig } from './core.js'
import { injectMobileLayer } from './mobile.js'
import {
  loadOrCreateState,
  defaultStateFile,
  defaultStatusFile,
  defaultUrlFile,
} from './state.js'
import { VERSION, localIPv4Addresses, tailscaleIPv4Addresses } from './util.js'

/** Stable Cordis plugin name. */
export const name = 'dsh-remote-mobile'
/** Both services must exist before the listener can mint its upstream cookie. */
export const inject = ['webServer', 'connection']

/** Build a logger tolerant of both Cordis logger shapes. */
function createLog(ctx) {
  const base = typeof ctx.logger === 'function' ? ctx.logger('remote-mobile') : ctx.logger
  return (level, message) => {
    const target = base?.[level] ?? base?.info
    if (typeof target !== 'function') return
    try {
      target.call(base, `[remote-mobile] ${message}`)
    } catch {
      /* logging must never break the listener */
    }
  }
}

/** Resolve the addresses this listener binds. */
export function resolveHosts(bind, explicitHosts = []) {
  const hosts = Array.isArray(explicitHosts) ? explicitHosts.map(String).filter(Boolean) : []
  if (hosts.length > 0) return hosts
  const mode = String(bind ?? 'auto').trim()
  const tailscale = tailscaleIPv4Addresses()
  const loopback = '127.0.0.1'
  if (mode === '' || mode === 'auto') {
    return tailscale.length > 0 ? [...tailscale, loopback] : [loopback]
  }
  if (mode === 'tailscale') {
    return tailscale.length > 0 ? [...tailscale, loopback] : [loopback]
  }
  if (mode === 'loopback' || mode === 'localhost') return [loopback]
  if (mode === 'lan') {
    const lan = localIPv4Addresses()
      .map((entry) => entry.address)
      .filter((address) => !tailscale.includes(address))
    return lan.length > 0 ? [...lan, loopback] : [loopback]
  }
  if (mode === 'all' || mode === '0.0.0.0') return ['0.0.0.0']
  if (isIP(mode) !== 0) return [mode]
  throw new Error(`remote-mobile: unknown bind mode ${JSON.stringify(mode)}`)
}

/** Read the small subset of config that also accepts environment overrides. */
function resolveRuntimeConfig(raw) {
  const env = process.env
  return {
    ...raw,
    port: raw.port ?? (env.DSH_REMOTE_MOBILE_PORT !== undefined ? Number(env.DSH_REMOTE_MOBILE_PORT) : undefined),
    bind: raw.bind ?? env.DSH_REMOTE_MOBILE_BIND,
    accessKey: raw.accessKey ?? env.DSH_REMOTE_MOBILE_KEY,
  }
}

/**
 * Mount the listener and the index tap.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config]
 */
export async function apply(ctx, config = {}) {
  const raw = resolveRuntimeConfig(config && typeof config === 'object' ? config : {})
  if (raw.enabled === false) return
  const log = createLog(ctx)

  let upstreamOrigin
  try {
    upstreamOrigin = ctx.webServer.getOrigin()
  } catch (error) {
    log('error', `cannot resolve the Desktop web origin: ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  let launchToken = ''
  try {
    const authenticated = new URL(ctx.connection.authenticatedUrl(`${upstreamOrigin}/`))
    launchToken = authenticated.searchParams.get('token') ?? ''
  } catch (error) {
    log('error', `cannot mint the upstream launch token: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (launchToken === '') {
    log('error', 'the Desktop connection returned an empty launch token; remote access is disabled for this launch')
    return
  }

  let hosts
  try {
    hosts = resolveHosts(raw.bind, raw.hosts)
  } catch (error) {
    log('error', error instanceof Error ? error.message : String(error))
    return
  }

  const stateFile = raw.stateFile ? String(raw.stateFile) : defaultStateFile()
  let state
  try {
    const loaded = loadOrCreateState(stateFile, { accessKey: raw.accessKey })
    state = loaded.state
    if (loaded.created) log('info', `created ${stateFile}`)
    if (loaded.repaired) log('warn', `repaired ${stateFile}`)
  } catch (error) {
    log('error', `cannot load the access-key state: ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  const normalized = normalizeConfig({
    ...raw,
    hosts,
    accessKey: state.accessKey,
    statusFile: raw.statusFile !== undefined ? String(raw.statusFile) : defaultStatusFile(),
    urlFile: raw.urlFile !== undefined ? String(raw.urlFile) : defaultUrlFile(),
  })

  const server = new RemoteMobileServer({
    upstreamOrigin,
    launchToken,
    accessKey: state.accessKey,
    secret: state.secret,
    config: normalized,
    log,
  })

  const disposers = []
  if (normalized.mobileLayer) {
    try {
      disposers.push(ctx.webServer.tapIndex((html) => injectMobileLayer(html, { version: VERSION })))
      disposers.push(ctx.webServer.register({
        kind: 'prefix',
        path: '/_dsh-mobile',
        handler: (request, response) => server.serveAsset(request, response),
      }))
    } catch (error) {
      log('warn', `could not install the mobile layer: ${error instanceof Error ? error.message : String(error)}`)
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* already gone */
        }
      }
    }
  }

  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* already gone */
      }
    }
    server.close().catch(() => {})
  }, 'remote-mobile: listener + mobile layer')

  try {
    await server.start()
  } catch (error) {
    log('error', `listener failed to start: ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  for (const url of server.getUrls()) log('info', `phone URL: ${url}`)
  log('info', `state: ${stateFile}`)
  if (normalized.publicUrl === '' && tailscaleIPv4Addresses().length === 0) {
    log('warn', 'no Tailscale IPv4 address was found; the listener is loopback-only')
  }
}

export { RemoteMobileServer, normalizeConfig, injectMobileLayer }
