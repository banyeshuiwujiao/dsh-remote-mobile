/*
 * dsh-remote-mobile — mobile affordances.
 *
 * The overlay lives in a closed shadow root so its styles cannot leak into the
 * Harness UI and the app's styles cannot reshape it. All actions use existing
 * app surfaces: the sidebar keyboard shortcut, the composer, and scrolling.
 */
(function () {
  'use strict'

  if (window.__DSH_MOBILE_READY__ === true) return
  window.__DSH_MOBILE_READY__ = true

  var OFF_KEY = 'dsh-mobile-off'
  var coarse = false
  var narrow = false
  try {
    coarse = window.matchMedia('(pointer: coarse)').matches
    narrow = window.innerWidth <= 900
  } catch (error) {
    narrow = window.innerWidth <= 900
  }
  var disabled = false
  try {
    disabled = window.localStorage.getItem(OFF_KEY) === '1'
  } catch (error) {
    disabled = false
  }
  if (disabled || !(coarse || narrow)) return

  var html = document.documentElement
  html.classList.add('dsh-mobile')
  html.setAttribute('data-dsh-mobile', '1')

  var zh = true
  try {
    var lang = (navigator.language || html.lang || '').toLowerCase()
    zh = lang.indexOf('zh') === 0 || lang === ''
  } catch (error) {
    zh = true
  }
  function t(zhText, enText) {
    return zh ? zhText : enText
  }

  var styles = [
    ':host{all:initial}',
    ':host{--dsh-mobile-kb:0px}',
    '.host{position:fixed;inset:auto 0 0 auto;z-index:900;pointer-events:none;font:14px/1.4 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}',
    '.fab{position:fixed;right:16px;bottom:calc(18px + env(safe-area-inset-bottom,0px) + var(--dsh-mobile-kb,0px));width:52px;height:52px;border:0;border-radius:50%;background:linear-gradient(135deg,#4d7cfe,#7a6bff);color:#fff;box-shadow:0 10px 30px #0007,0 2px 8px #0006;display:grid;place-items:center;pointer-events:auto;touch-action:manipulation;cursor:pointer;transition:transform .16s ease,opacity .16s ease}',
    '.fab:active{transform:scale(.94)}',
    '.fab svg{width:24px;height:24px;display:block}',
    '.sheet{position:fixed;left:0;right:0;bottom:0;z-index:901;pointer-events:auto;transform:translateY(110%);transition:transform .22s cubic-bezier(.2,.9,.25,1);padding:0 10px calc(10px + env(safe-area-inset-bottom,0px) + var(--dsh-mobile-kb,0px));}',
    '.sheet.open{transform:translateY(0)}',
    '.scrim{position:fixed;inset:0;z-index:900;background:#0008;backdrop-filter:blur(2px);opacity:0;pointer-events:none;transition:opacity .18s ease}',
    '.scrim.open{opacity:1;pointer-events:auto}',
    '.card{max-width:520px;margin:0 auto;background:#121821;border:1px solid #2a3648;border-radius:20px;box-shadow:0 20px 60px #0008;padding:10px;color:#e7ecf3}',
    '.head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 8px 10px;color:#8fa0b5;font-size:12px}',
    '.close{width:34px;height:34px;border:0;border-radius:10px;background:#1b2533;color:#c9d4e3;font-size:18px;display:grid;place-items:center;touch-action:manipulation}',
    '.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}',
    '.item{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;min-height:76px;padding:10px 6px;border:1px solid #223044;border-radius:14px;background:#0f1620;color:#e7ecf3;font:600 12px/1.2 inherit;touch-action:manipulation;cursor:pointer}',
    '.item:active{background:#182233}',
    '.item .glyph{font-size:20px;line-height:1}',
    '.item .sub{color:#7f90a5;font-size:10px;font-weight:400}',
    '.note{padding:8px 8px 4px;color:#6f8095;font-size:11px}',
    '.toast{position:fixed;left:50%;bottom:calc(92px + env(safe-area-inset-bottom,0px) + var(--dsh-mobile-kb,0px));transform:translate(-50%,10px);z-index:902;max-width:min(90vw,420px);padding:9px 13px;border-radius:999px;background:#1b2533e8;border:1px solid #31425a;color:#dbe5f2;font-size:12px;opacity:0;pointer-events:none;transition:opacity .18s ease,transform .18s ease;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.toast.show{opacity:1;transform:translate(-50%,0)}',
    '@media (max-width:380px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}',
    '@media (prefers-reduced-motion:reduce){.fab,.sheet,.scrim,.toast{transition:none}}',
  ].join('')

  var host = document.createElement('div')
  host.className = 'host'
  host.setAttribute('data-dsh-mobile-ui', '1')
  var root = host.attachShadow({ mode: 'open' })
  var style = document.createElement('style')
  style.textContent = styles
  root.appendChild(style)

  var scrim = document.createElement('div')
  scrim.className = 'scrim'
  var sheet = document.createElement('div')
  sheet.className = 'sheet'
  var card = document.createElement('div')
  card.className = 'card'
  var head = document.createElement('div')
  head.className = 'head'
  var headText = document.createElement('span')
  headText.textContent = t('手机远程控制', 'Mobile control')
  var close = document.createElement('button')
  close.className = 'close'
  close.type = 'button'
  close.setAttribute('aria-label', t('关闭', 'Close'))
  close.textContent = '×'
  head.appendChild(headText)
  head.appendChild(close)
  var grid = document.createElement('div')
  grid.className = 'grid'
  var note = document.createElement('div')
  note.className = 'note'
  note.textContent = t('Ctrl+Alt+B 可展开/收起侧栏；桌面版可在手机上保留完整布局。', 'Shortcuts and layout follow the desktop app; switch back to desktop layout any time.')
  card.appendChild(head)
  card.appendChild(grid)
  card.appendChild(note)
  sheet.appendChild(card)
  var fab = document.createElement('button')
  fab.className = 'fab'
  fab.type = 'button'
  fab.setAttribute('aria-label', t('打开手机工具', 'Open mobile tools'))
  fab.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 7h14M5 12h14M5 17h14"/></svg>'
  var toast = document.createElement('div')
  toast.className = 'toast'
  root.appendChild(scrim)
  root.appendChild(sheet)
  root.appendChild(fab)
  root.appendChild(toast)
  document.body.appendChild(host)

  var toastTimer = null
  function showToast(message) {
    toast.textContent = message
    toast.classList.add('show')
    if (toastTimer !== null) window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(function () {
      toast.classList.remove('show')
      toastTimer = null
    }, 2200)
  }

  function openSheet() {
    scrim.classList.add('open')
    sheet.classList.add('open')
    fab.style.opacity = '0'
    fab.style.pointerEvents = 'none'
  }
  function closeSheet() {
    scrim.classList.remove('open')
    sheet.classList.remove('open')
    fab.style.opacity = '1'
    fab.style.pointerEvents = 'auto'
  }
  fab.addEventListener('click', function (event) {
    event.preventDefault()
    openSheet()
  })
  close.addEventListener('click', closeSheet)
  scrim.addEventListener('click', closeSheet)

  function visible(element) {
    if (!(element instanceof HTMLElement)) return false
    var rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    var style = window.getComputedStyle(element)
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'
  }

  function dispatchKey(options) {
    try {
      var event = new KeyboardEvent('keydown', Object.assign({
        bubbles: true,
        cancelable: true,
        composed: true,
      }, options))
      document.dispatchEvent(event)
      window.dispatchEvent(event)
    } catch (error) {
      /* KeyboardEvent is always available in target browsers */
    }
  }

  function toggleSidebar() {
    dispatchKey({ key: 'b', code: 'KeyB', keyCode: 66, which: 66, ctrlKey: true, altKey: true })
    window.setTimeout(function () {
      var candidates = document.querySelectorAll('button[aria-label],[aria-keyshortcuts]')
      for (var index = 0; index < candidates.length; index++) {
        var button = candidates[index]
        var label = (button.getAttribute('aria-label') || '') + ' ' + (button.getAttribute('aria-keyshortcuts') || '')
        if (!/sidebar|侧栏|左侧|toggle left/i.test(label)) continue
        if (!visible(button)) continue
        button.click()
        return
      }
    }, 90)
  }

  function findComposer() {
    var textareas = document.querySelectorAll('textarea:not([disabled]), [contenteditable="true"]')
    for (var index = 0; index < textareas.length; index++) {
      var element = textareas[index]
      if (visible(element)) return element
    }
    return null
  }

  function focusComposer() {
    var composer = findComposer()
    if (composer === null) {
      showToast(t('没有找到输入框', 'No composer found'))
      return
    }
    try {
      composer.focus({ preventScroll: true })
      if (typeof composer.click === 'function') composer.click()
      composer.scrollIntoView({ block: 'center', behavior: 'smooth' })
    } catch (error) {
      showToast(t('无法聚焦输入框', 'Could not focus the composer'))
    }
  }

  function findScroller() {
    var best = null
    var bestScore = 0
    var nodes = document.querySelectorAll('*')
    for (var index = 0; index < nodes.length; index++) {
      var element = nodes[index]
      if (!(element instanceof HTMLElement)) continue
      if (element.scrollHeight <= element.clientHeight + 160) continue
      if (element.clientHeight < 180) continue
      var style = window.getComputedStyle(element)
      if (!/(auto|scroll|overlay)/.test(style.overflowY)) continue
      var rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue
      var score = element.scrollHeight - element.clientHeight
      if (score > bestScore) {
        bestScore = score
        best = element
      }
    }
    return best
  }

  function scrollToLatest() {
    var scroller = findScroller()
    if (scroller !== null) {
      scroller.scrollTop = scroller.scrollHeight
      window.setTimeout(function () {
        scroller.scrollTop = scroller.scrollHeight
      }, 60)
      showToast(t('已回到最新', 'Jumped to latest'))
      return
    }
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' })
  }

  function newSession() {
    var nodes = document.querySelectorAll('button,[role="button"]')
    for (var index = 0; index < nodes.length; index++) {
      var element = nodes[index]
      var label = (element.getAttribute('aria-label') || '') + ' ' + (element.textContent || '')
      if (!/新会话|新建|new session|new chat/i.test(label)) continue
      if (!visible(element)) continue
      element.click()
      return
    }
    showToast(t('请先打开侧栏，再点「新会话」', 'Open the sidebar and choose New Session'))
  }

  function action(labelZh, labelEn, glyph, handler) {
    var button = document.createElement('button')
    button.className = 'item'
    button.type = 'button'
    var icon = document.createElement('span')
    icon.className = 'glyph'
    icon.textContent = glyph
    var text = document.createElement('span')
    text.textContent = t(labelZh, labelEn)
    button.appendChild(icon)
    button.appendChild(text)
    button.addEventListener('click', function () {
      closeSheet()
      handler()
    })
    grid.appendChild(button)
  }

  action('侧栏', 'Sidebar', '☰', toggleSidebar)
  action('输入框', 'Composer', '⌨', focusComposer)
  action('最新消息', 'Latest', '⬇', scrollToLatest)
  action('新会话', 'New chat', '＋', newSession)
  action('刷新', 'Reload', '⟳', function () {
    window.location.reload()
  })
  action('全屏', 'Fullscreen', '⛶', function () {
    var element = document.documentElement
    if (element.requestFullscreen) {
      element.requestFullscreen().catch(function () {
        showToast(t('浏览器不允许全屏', 'Fullscreen was refused'))
      })
    } else {
      showToast(t('此浏览器不支持全屏', 'Fullscreen is unsupported here'))
    }
  })
  action('桌面版', 'Desktop', '🖥', function () {
    try {
      window.localStorage.setItem(OFF_KEY, '1')
    } catch (error) {
      /* private mode */
    }
    window.location.reload()
  })
  action('状态', 'Status', 'ⓘ', function () {
    window.location.href = '/_dsh-mobile/status?format=html'
  })
  action('退出登录', 'Sign out', '⏻', function () {
    window.location.href = '/_dsh-mobile/logout'
  })

  function updateKeyboardOffset() {
    var viewport = window.visualViewport
    if (viewport === undefined || viewport === null) return
    var offset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
    host.style.setProperty('--dsh-mobile-kb', offset + 'px')
    if (offset > 120) closeSheet()
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateKeyboardOffset)
    window.visualViewport.addEventListener('scroll', updateKeyboardOffset)
    updateKeyboardOffset()
  }
})()
