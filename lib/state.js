/**
 * Persistent plugin state: the access key and the cookie-signing secret.
 *
 * The file lives under `$DSH_HOME/remote-mobile/state.json`. It is created with
 * the user's own ACLs (no world-readable share is involved) and rewritten
 * atomically. Losing it only means the phone has to enter a new key.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeKey, randomKey, randomToken, resolveDshHome } from './util.js'

const STATE_VERSION = 1

/** Default state file location. */
export function defaultStateFile() {
  return join(resolveDshHome(), 'remote-mobile', 'state.json')
}

/** Default status file location (shown in the desktop status page too). */
export function defaultStatusFile() {
  return join(resolveDshHome(), 'remote-mobile', 'status.json')
}

/** Default URL file location. */
export function defaultUrlFile() {
  return join(resolveDshHome(), 'remote-mobile', 'url.txt')
}

function isValidState(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  if (value.version !== STATE_VERSION) return false
  if (typeof value.secret !== 'string' || value.secret.length < 32) return false
  if (typeof value.accessKey !== 'string') return false
  const key = normalizeKey(value.accessKey)
  return key.length >= 6 && key.length <= 64
}

/** Write a file atomically inside its directory. */
export function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}`
  writeFileSync(temporary, text, 'utf8')
  renameSync(temporary, file)
}

/**
 * Load the state, creating or repairing it when necessary.
 * @param {string} file - absolute state path.
 * @param {{ accessKey?: string }} [options] - explicit key from profile config.
 * @returns {{ state: object, file: string, created: boolean, repaired: boolean }}
 */
export function loadOrCreateState(file, options = {}) {
  const explicitKey = options.accessKey === undefined || options.accessKey === ''
    ? undefined
    : normalizeKey(options.accessKey)
  let created = false
  let repaired = false
  let state
  if (existsSync(file)) {
    try {
      state = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      state = undefined
    }
  }
  if (!isValidState(state)) {
    if (state !== undefined) repaired = true
    else created = true
    state = {
      version: STATE_VERSION,
      accessKey: explicitKey ?? randomKey(10),
      secret: randomToken(32),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  } else if (explicitKey !== undefined && state.accessKey !== explicitKey) {
    // A profile-provided key wins and is persisted, so a restart keeps the
    // same key even if the row later drops back to an empty value.
    state.accessKey = explicitKey
    state.updatedAt = new Date().toISOString()
    repaired = true
  }
  writeAtomic(file, `${JSON.stringify(state, null, 2)}\n`)
  return { state, file, created, repaired }
}

/** Persist an updated state object. */
export function saveState(file, state) {
  state.updatedAt = new Date().toISOString()
  writeAtomic(file, `${JSON.stringify(state, null, 2)}\n`)
}
