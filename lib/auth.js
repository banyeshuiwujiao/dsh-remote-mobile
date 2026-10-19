/**
 * Authentication and peer admission for the phone-facing listener.
 *
 * Two independent gates:
 *   1. The peer address must belong to `allowedNetworks` (Tailscale CGNAT and
 *      loopback by default). Binding a Tailscale address is the primary fence;
 *      this is a second, explicit one.
 *   2. A signed, host-bound, HttpOnly cookie minted only after the access key
 *      is entered. The key is compared in constant time and rate-limited.
 *
 * The upstream DSH cookie never reaches the phone: the proxy mints and keeps it
 * server-side.
 */
import { createHmac } from 'node:crypto'
import { normalizeKey, normalizeRemoteAddress, isAllowedAddress, safeEqual } from './util.js'

const COOKIE_NAME = 'dshm'
const COOKIE_VERSION = 'v1'
const DEFAULT_WINDOW_MS = 10 * 60 * 1000
const DEFAULT_LOCK_MS = 5 * 60 * 1000

/** Read one cookie value from a Cookie header without a parser dependency. */
export function readCookie(headerValue, name) {
  if (typeof headerValue !== 'string' || headerValue === '') return undefined
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    if (segment.slice(0, at).trim() === name) return segment.slice(at + 1).trim()
  }
  return undefined
}

/** HMAC-SHA256 over the audience and expiry. */
function sign(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

/** Access control shared by HTTP and WebSocket requests. */
export class AccessControl {
  /**
   * @param {object} options
   * @param {string} options.accessKey - human-typeable key.
   * @param {string} options.secret - cookie-signing secret (base64url).
   * @param {number} [options.cookieMaxAgeDays] - absolute cookie lifetime.
   * @param {string[]} options.allowedNetworks - peer allow list.
   * @param {boolean} [options.tls] - whether this listener terminates TLS.
   * @param {boolean} [options.trustProxy] - honor `X-Forwarded-Proto`.
   * @param {number} [options.maxFailures] - failed attempts per window.
   * @param {number} [options.lockMs] - lockout after the window is exhausted.
   */
  constructor(options) {
    this.accessKey = normalizeKey(options.accessKey)
    this.secret = options.secret
    this.cookieMaxAgeMs = Math.max(1, Number(options.cookieMaxAgeDays ?? 30)) * 24 * 60 * 60 * 1000
    this.allowedNetworks = options.allowedNetworks
    this.tls = options.tls === true
    this.trustProxy = options.trustProxy === true
    this.maxFailures = Math.max(1, Number(options.maxFailures ?? 8))
    this.windowMs = Math.max(1000, Number(options.windowMs ?? DEFAULT_WINDOW_MS))
    this.lockMs = Math.max(1000, Number(options.lockMs ?? DEFAULT_LOCK_MS))
    /** @type {Map<string, { count: number, firstAt: number, lockedUntil: number }>} */
    this.failures = new Map()
    this.lastSweep = Date.now()
  }

  /** Whether this peer may talk to the listener at all. */
  admitsPeer(request) {
    const address = normalizeRemoteAddress(request.socket?.remoteAddress)
    return isAllowedAddress(address, this.allowedNetworks)
  }

  /** The peer address, normalized for logs and rate-limit keys. */
  peerAddress(request) {
    return normalizeRemoteAddress(request.socket?.remoteAddress)
  }

  /** Whether cookies must carry `Secure`. */
  secure(request) {
    if (this.tls) return true
    if (!this.trustProxy) return false
    const proto = request.headers['x-forwarded-proto']
    return typeof proto === 'string' && proto.split(',')[0].trim().toLowerCase() === 'https'
  }

  /** Cookie audience: the exact authority the phone used. */
  audience(request) {
    return String(request.headers.host ?? '').toLowerCase()
  }

  /** Extract the access key from query, header, or bearer token. */
  credentialFrom(request, url) {
    const query = url?.searchParams?.get('key')
    if (query !== null && query !== undefined && query !== '') return { key: query, source: 'query' }
    const header = request.headers['x-dsh-mobile-key']
    if (typeof header === 'string' && header !== '') return { key: header, source: 'header' }
    const authorization = request.headers.authorization
    if (typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ')) {
      return { key: authorization.slice(7).trim(), source: 'bearer' }
    }
    return undefined
  }

  /** Check the signed session cookie. */
  isAuthenticated(request) {
    const raw = readCookie(request.headers.cookie, COOKIE_NAME)
    if (raw === undefined) return false
    const parts = raw.split('.')
    if (parts.length !== 3 || parts[0] !== COOKIE_VERSION) return false
    const expiresAt = Number(parts[1])
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return false
    const audience = this.audience(request)
    if (audience === '') return false
    const expected = sign(this.secret, `${audience}|${String(expiresAt)}`)
    return safeEqual(parts[2], expected)
  }

  /** Build the Set-Cookie header value for a successful login. */
  sessionCookie(request) {
    const expiresAt = Date.now() + this.cookieMaxAgeMs
    const audience = this.audience(request)
    const value = `${COOKIE_VERSION}.${String(expiresAt)}.${sign(this.secret, `${audience}|${String(expiresAt)}`)}`
    const maxAgeSeconds = Math.floor(this.cookieMaxAgeMs / 1000)
    const attributes = `${COOKIE_NAME}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; HttpOnly; SameSite=Lax`
    return this.secure(request) ? `${attributes}; Secure` : attributes
  }

  /** Build the Set-Cookie header value that removes the session cookie. */
  clearCookie(request) {
    const attributes = `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`
    return this.secure(request) ? `${attributes}; Secure` : attributes
  }

  /** Whether a peer is currently locked out after repeated failures. */
  isLocked(address) {
    const row = this.failures.get(address)
    if (row === undefined) return false
    if (row.lockedUntil > Date.now()) return true
    if (row.lockedUntil !== 0) this.failures.delete(address)
    return false
  }

  /** Record one failed key attempt and return the resulting lock state. */
  noteFailure(address) {
    const now = Date.now()
    // Opportunistic sweep so a long-lived process cannot grow the map without
    // bound when many peers fail once each.
    if (now - this.lastSweep > this.windowMs) {
      for (const [key, row] of this.failures) {
        if (row.lockedUntil !== 0 && row.lockedUntil <= now) this.failures.delete(key)
        else if (row.lockedUntil === 0 && now - row.firstAt > this.windowMs) this.failures.delete(key)
      }
      this.lastSweep = now
    }
    let row = this.failures.get(address)
    if (row === undefined || (row.lockedUntil === 0 && now - row.firstAt > this.windowMs)) {
      row = { count: 0, firstAt: now, lockedUntil: 0 }
      this.failures.set(address, row)
    }
    row.count += 1
    if (row.count >= this.maxFailures) {
      row.lockedUntil = now + this.lockMs
      return { locked: true, retryAfterMs: this.lockMs }
    }
    return { locked: false, remaining: this.maxFailures - row.count }
  }

  /** Clear the failure record after a successful login. */
  noteSuccess(address) {
    this.failures.delete(address)
  }

  /**
   * Verify an access key, honoring the per-peer lockout.
   * @returns {{ ok: true, address: string } | { ok: false, reason: 'locked'|'invalid', address: string, retryAfterMs?: number, remaining?: number }}
   */
  verifyKey(request, candidate) {
    const address = this.peerAddress(request)
    if (this.isLocked(address)) {
      const row = this.failures.get(address)
      return { ok: false, reason: 'locked', address, retryAfterMs: Math.max(0, (row?.lockedUntil ?? 0) - Date.now()) }
    }
    const normalized = normalizeKey(candidate)
    if (normalized === '' || !safeEqual(normalized, this.accessKey)) {
      const result = this.noteFailure(address)
      return {
        ok: false,
        reason: result.locked ? 'locked' : 'invalid',
        address,
        ...(result.locked ? { retryAfterMs: result.retryAfterMs } : { remaining: result.remaining }),
      }
    }
    this.noteSuccess(address)
    return { ok: true, address }
  }
}
