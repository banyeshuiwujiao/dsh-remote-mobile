/**
 * HTML surfaces owned by the plugin: the index injection, the key-entry page,
 * and the authenticated status page.
 *
 * The injection is a *tap* on the upstream index. It stays inert on desktop
 * widths because the mobile stylesheet is gated behind `html.dsh-mobile`, a
 * class the mobile script only adds for coarse pointers or narrow viewports.
 */
import { escapeHtml } from './util.js'

const MARKER = 'data-dsh-mobile-layer'

/** Strip anything that would break an inline `<script>`. */
function inlineScriptSafe(text) {
  return String(text).replaceAll('</script', '<\\/script')
}

/**
 * Inject the mobile layer into an index.html body.
 * @param {string} html - upstream index.html.
 * @param {{ version: string }} options
 * @returns {string}
 */
export function injectMobileLayer(html, options = {}) {
  const version = encodeURIComponent(String(options.version ?? '0'))
  if (typeof html !== 'string' || html.includes(MARKER)) return html

  const head = [
    `<meta ${MARKER} content="${escapeHtml(version)}">`,
    '<meta name="mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
    '<meta name="format-detection" content="telephone=no">',
    `<link rel="stylesheet" href="/_dsh-mobile/mobile.css?v=${version}">`,
    `<script>${inlineScriptSafe(`(function(){try{var q=location.search;if(q.indexOf('mobile=1')!==-1)localStorage.removeItem('dsh-mobile-off');if(q.indexOf('desktop=1')!==-1)localStorage.setItem('dsh-mobile-off','1');var hist=history;if((q.indexOf('desktop=1')!==-1||q.indexOf('mobile=1')!==-1)&&hist.replaceState){var u=new URL(location.href);u.searchParams.delete('desktop');u.searchParams.delete('mobile');hist.replaceState(null,'',u.pathname+u.search+u.hash)}}catch(e){}})();`)}</script>`,
  ].join('')

  const body = `<script src="/_dsh-mobile/mobile.js?v=${version}" defer></script>`

  let out = html
  const headClose = out.search(/<\/head\s*>/iu)
  out = headClose === -1 ? `${head}${out}` : `${out.slice(0, headClose)}${head}${out.slice(headClose)}`
  const bodyClose = out.search(/<\/body\s*>/iu)
  out = bodyClose === -1 ? `${out}${body}` : `${out.slice(0, bodyClose)}${body}${out.slice(bodyClose)}`
  return out
}

const LOGIN_CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;background:#0b0f14;color:#e7ecf3;display:flex;align-items:center;justify-content:center;padding:max(20px,env(safe-area-inset-top)) 20px max(20px,env(safe-area-inset-bottom))}
.card{width:100%;max-width:380px;background:#121821;border:1px solid #22303f;border-radius:20px;padding:28px 22px 22px;box-shadow:0 24px 80px #0008}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.mark{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,#4d7cfe,#9b6bff);display:grid;place-items:center;font-weight:700;font-size:15px;color:#fff}
h1{font-size:19px;line-height:1.3;margin:0}
p{margin:8px 0 0;color:#93a1b3;font-size:13px}
label{display:block;margin:22px 0 8px;font-size:13px;color:#aab7c8;font-weight:600}
input[type=text]{width:100%;height:54px;border-radius:14px;border:1px solid #2b3a4c;background:#0b0f14;color:#fff;font:600 20px/1 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.18em;text-align:center;text-transform:uppercase;padding:0 14px;outline:none}
input[type=text]:focus{border-color:#5b8cff;box-shadow:0 0 0 4px #5b8cff22}
button{width:100%;height:52px;margin-top:14px;border:0;border-radius:14px;background:linear-gradient(135deg,#4d7cfe,#7a6bff);color:#fff;font:600 16px/1 inherit;cursor:pointer;touch-action:manipulation}
button:active{transform:translateY(1px)}
.err{margin-top:14px;padding:10px 12px;border-radius:12px;background:#3a1520;border:1px solid #7c2237;color:#ffb3c1;font-size:13px}
.hint{margin-top:16px;font-size:12px;color:#6f7f92;line-height:1.6}
.hint code{color:#aebdd0;background:#0b0f14;border:1px solid #22303f;border-radius:6px;padding:1px 5px}
.meta{margin-top:18px;font-size:11px;color:#4c5b6d;display:flex;justify-content:space-between;gap:8px}
a{color:#7fa3ff}
`

/**
 * Render the key-entry page.
 * @param {{ error?: string, lockedUntil?: number, host?: string, address?: string, version?: string }} options
 */
export function renderLoginPage(options = {}) {
  const error = options.error === undefined
    ? ''
    : `<div class="err" role="alert">${escapeHtml(options.error)}</div>`
  const locked = typeof options.lockedUntil === 'number' && options.lockedUntil > Date.now()
  const disabled = locked ? ' disabled' : ''
  const lockText = locked
    ? `<div class="err">尝试次数过多，请等待约 ${Math.ceil((options.lockedUntil - Date.now()) / 1000)} 秒后再试。</div>`
    : error
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><title>登录 · DSH 手机远程</title><style>${LOGIN_CSS}</style></head><body>
<main class="card">
  <div class="brand"><div class="mark">DSH</div><h1>手机远程访问</h1></div>
  <p>输入电脑端「DSH 手机远程」插件生成的访问密钥。</p>
  <form method="post" action="/_dsh-mobile/login" autocomplete="off">
    <label for="key">访问密钥</label>
    <input id="key" name="key" type="text" inputmode="text" autocapitalize="characters" autocomplete="one-time-code" spellcheck="false" maxlength="64" placeholder="例如 K7M2QP9X4R"${disabled} autofocus>
    <button type="submit"${disabled}>登录</button>
  </form>
  ${lockText}
  <div class="hint">密钥在电脑端插件启动日志 / <code>~/.dsh/remote-mobile/url.txt</code> 中。登录后此设备会获得 30 天有效的签名 Cookie。</div>
  <div class="meta"><span>${escapeHtml(options.host ?? '')}</span><span>${escapeHtml(options.address ?? '')}</span></div>
</main>
</body></html>`
}

/** Render a small authenticated status page. */
export function renderStatusPage(status) {
  const urls = Array.isArray(status.urls) ? status.urls : []
  const rows = [
    ['版本', status.version],
    ['监听', (status.hosts ?? []).map((host) => `${host}:${status.port}`).join(', ')],
    ['上游', status.upstream?.origin ?? ''],
    ['上游 Cookie', status.upstream?.cookieAgeSeconds === null ? '尚未登录' : `${status.upstream.cookieAgeSeconds}s 前获取`],
    ['请求数', status.requests],
    ['最近请求', status.lastRequestAt ?? '—'],
    ['客户端', (status.clients ?? []).join(', ') || '—'],
    ['启动时间', status.startedAt],
  ]
  const rowHtml = rows
    .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`)
    .join('')
  const urlHtml = urls
    .map((url) => `<li><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></li>`)
    .join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH 手机远程 · 状态</title><style>body{font:15px/1.55 system-ui,-apple-system,"Segoe UI","PingFang SC",sans-serif;background:#0b0f14;color:#e7ecf3;padding:24px;max-width:760px;margin:0 auto}h1{font-size:20px}table{width:100%;border-collapse:collapse;margin:16px 0}th,td{text-align:left;padding:9px 8px;border-bottom:1px solid #1d2836;vertical-align:top}th{color:#8c9bad;font-weight:600;width:34%}code,a{color:#8fb2ff;word-break:break-all}li{margin:6px 0}</style></head><body><h1>DSH 手机远程 · 状态</h1><table>${rowHtml}</table><h2 style="font-size:16px">可用地址</h2><ul>${urlHtml || '<li>—</li>'}</ul><p><a href="/">返回应用</a> · <a href="/_dsh-mobile/logout">退出登录</a></p></body></html>`
}
