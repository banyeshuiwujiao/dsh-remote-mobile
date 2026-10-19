import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { apply, resolveHosts } from '../lib/index.js'

const HTML = '<!doctype html><html><head><title>Mock</title></head><body><div id="root"></div></body></html>'

function createUpstream() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x')
    if (url.pathname === '/' && url.searchParams.get('token') === 'tok') {
      response.writeHead(303, {
        'set-cookie': 'dsh-auth-test=ok; Path=/; HttpOnly; SameSite=Strict',
        location: './',
        'content-length': '0',
      })
      response.end()
      return
    }
    if (url.pathname === '/' && request.headers.cookie === 'dsh-auth-test=ok') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(HTML)
      return
    }
    response.writeHead(401)
    response.end('unauthorized')
  })
  return server
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

describe('cordis plugin wiring', () => {
  let upstream
  let upstreamPort
  let tempDir
  let plugin
  let logs
  let disposers
  let tap
  let routes

  before(async () => {
    upstream = createUpstream()
    upstreamPort = await listen(upstream)
    tempDir = mkdtempSync(join(tmpdir(), 'dsh-remote-mobile-test-'))
    logs = []
    disposers = []
    routes = []
    const ctx = {
      logger: {
        info: (message) => logs.push(['info', message]),
        warn: (message) => logs.push(['warn', message]),
        error: (message) => logs.push(['error', message]),
      },
      webServer: {
        getOrigin: () => `http://127.0.0.1:${upstreamPort}`,
        tapIndex: (fn) => {
          tap = fn
          return () => {
            tap = undefined
          }
        },
        register: (route) => {
          routes.push(route)
          return () => {}
        },
      },
      connection: {
        authenticatedUrl: (base) => `${base}?token=tok`,
      },
      effect: (fn) => {
        disposers.push(fn())
        return () => {}
      },
    }
    await apply(ctx, {
      port: 0,
      bind: 'loopback',
      accessKey: 'PLUGINTEST1',
      stateFile: join(tempDir, 'state.json'),
      statusFile: '',
      urlFile: '',
    })
  })

  after(async () => {
    for (const dispose of disposers.reverse()) {
      if (typeof dispose === 'function') await dispose()
    }
    upstream.closeAllConnections?.()
    await new Promise((resolve) => upstream.close(() => resolve()))
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('logs a phone URL containing the key', () => {
    const urls = logs
      .filter(([level, message]) => level === 'info' && message.includes('phone URL:'))
      .map(([, message]) => message)
    assert.ok(urls.length > 0, 'expected a phone URL log line')
    assert.match(urls[0], /key=PLUGINTEST1/)
  })

  test('persists the key state', () => {
    const state = JSON.parse(readFileSync(join(tempDir, 'state.json'), 'utf8'))
    assert.equal(state.version, 1)
    assert.equal(state.accessKey, 'PLUGINTEST1')
    assert.ok(state.secret.length >= 32)
  })

  test('taps the index with the mobile layer', () => {
    assert.equal(typeof tap, 'function')
    const out = tap(HTML)
    assert.match(out, /\/_dsh-mobile\/mobile\.css/)
  })

  test('registers the asset route', () => {
    assert.ok(routes.some((route) => route.kind === 'prefix' && route.path === '/_dsh-mobile'))
  })

  test('resolves bind modes', () => {
    assert.deepEqual(resolveHosts('loopback'), ['127.0.0.1'])
    assert.deepEqual(resolveHosts('auto', ['10.0.0.2']), ['10.0.0.2'])
    assert.deepEqual(resolveHosts('10.0.0.5'), ['10.0.0.5'])
    assert.throws(() => resolveHosts('nonsense'))
  })
})
