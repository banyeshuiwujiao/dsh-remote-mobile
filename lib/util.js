/**
 * dsh-remote-mobile — shared helpers.
 *
 * No third-party dependencies: the plugin must load even when the profile's
 * node_modules is a minimal checkout.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { homedir, networkInterfaces } from 'node:os'
import { isIP } from 'node:net'

/** Version surfaced in logs, status JSON, and asset cache keys. */
export const VERSION = '0.1.0'

/** URL-safe base64 without padding. */
export function base64url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

/** Cryptographically random URL-safe token. */
export function randomToken(bytes = 32) {
  return base64url(randomBytes(bytes))
}

/**
 * Access-key alphabet. Deliberately excludes I, O, 0 and 1 so a key read from
 * a desktop screen and typed on a phone cannot be confused.
 */
const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** Generate a human-typeable access key. */
export function randomKey(length = 10) {
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) out += KEY_ALPHABET[bytes[i] % KEY_ALPHABET.length]
  return out
}

/** Normalize a typed key: uppercase, strip separators, keep the alphabet. */
export function normalizeKey(value) {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/gu, '')
}

/** Constant-time string equality that never throws on length mismatch. */
export function safeEqual(left, right) {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Escape a value for HTML text and quoted attributes. */
export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Parse a dotted-quad IPv4 address into a uint32, or undefined. */
export function parseIPv4(value) {
  const text = String(value ?? '').trim()
  if (isIP(text) !== 4) return undefined
  const parts = text.split('.')
  let out = 0
  for (const part of parts) {
    const n = Number(part)
    if (!Number.isInteger(n) || n < 0 || n > 255) return undefined
    out = (out * 256 + n) >>> 0
  }
  return out
}

/** Whether an IPv4 address belongs to a CIDR block. */
export function ipv4InCidr(address, cidr) {
  const [base, bitsText] = String(cidr).split('/')
  const bits = bitsText === undefined ? 32 : Number(bitsText)
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false
  const ip = parseIPv4(address)
  const network = parseIPv4(base)
  if (ip === undefined || network === undefined) return false
  if (bits === 0) return true
  const mask = (0xffffffff << (32 - bits)) >>> 0
  return (ip & mask) >>> 0 === (network & mask) >>> 0
}

/** Normalize Node's remote address forms (IPv4-mapped IPv6 included). */
export function normalizeRemoteAddress(address) {
  let text = String(address ?? '')
  if (text.startsWith('::ffff:')) text = text.slice('::ffff:'.length)
  const zone = text.indexOf('%')
  if (zone !== -1) text = text.slice(0, zone)
  return text
}

/**
 * Check a peer address against the configured allow list.
 * Entries may be exact IPv4/IPv6 literals, IPv4 CIDR blocks, or `*`.
 */
export function isAllowedAddress(address, networks) {
  const text = normalizeRemoteAddress(address)
  if (text === '') return false
  for (const raw of networks) {
    const entry = String(raw).trim()
    if (entry === '' || entry === '*') return true
    if (entry.includes('/')) {
      if (ipv4InCidr(text, entry)) return true
      if (entry === '::1/128' && text === '::1') return true
      continue
    }
    if (entry === text) return true
    if (entry === 'localhost' && (text === '127.0.0.1' || text === '::1')) return true
  }
  return false
}

/** Whether an address is a Tailscale CGNAT address (100.64.0.0/10). */
export function isTailscaleAddress(address) {
  return ipv4InCidr(address, '100.64.0.0/10')
}

/** Collect the machine's non-internal IPv4 addresses. */
export function localIPv4Addresses() {
  const out = []
  for (const [name, rows] of Object.entries(networkInterfaces())) {
    for (const row of rows ?? []) {
      const family = row.family
      if (family !== 'IPv4' && family !== 4) continue
      if (row.internal) continue
      if (out.some((entry) => entry.address === row.address)) continue
      out.push({ address: row.address, name })
    }
  }
  return out
}

/** Tailscale IPv4 addresses on this machine, most specific first. */
export function tailscaleIPv4Addresses() {
  return localIPv4Addresses()
    .filter((entry) => isTailscaleAddress(entry.address))
    .map((entry) => entry.address)
}

/** A sensible advertised address when binding a wildcard. */
export function detectTailscaleHint() {
  return tailscaleIPv4Addresses()[0] ?? localIPv4Addresses()[0]?.address
}

/** The Harness home directory. */
export function resolveDshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : `${homedir()}\\.dsh`
}

/** Host text suitable for a URL (IPv6 literals get brackets). */
export function urlHost(address) {
  return String(address).includes(':') ? `[${address}]` : String(address)
}

/** `host:port` authority text. */
export function authority(address, port) {
  return `${urlHost(address)}:${String(port)}`
}

/** Parse a comma/space separated list of networks. */
export function parseNetworkList(value) {
  if (value === undefined || value === null) return undefined
  if (Array.isArray(value)) return value.map(String).map((v) => v.trim()).filter(Boolean)
  return String(value)
    .split(/[,\s]+/u)
    .map((v) => v.trim())
    .filter(Boolean)
}

/** Small promise-based sleep used by tests and shutdown paths. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
