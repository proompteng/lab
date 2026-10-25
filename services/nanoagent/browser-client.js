import RFB from '/novnc/core/rfb.js'
const status = document.getElementById('status')
const screen = document.getElementById('screen')
const clipboard = document.getElementById('clipboard')
const control = document.getElementById('control')
const channel = 'tengri-browser-v1'
const sessionId = location.hostname.split('.')[0].slice(-24)
const notify = (type, error) => parent.postMessage({ channel, sessionId, type, error }, '*')
const connection = new URL('/websockify', location.href)
connection.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
let rfb
let reconnectTimer
let reconnectAttempts = 0
let closed = false
const connect = () => {
  if (closed) return
  rfb = new RFB(screen, connection.href, { wsProtocols: ['binary'] })
  rfb.resizeSession = true
  rfb.scaleViewport = true
  rfb.background = '#202124'
  rfb.qualityLevel = 9
  rfb.addEventListener('connect', () => {
    reconnectAttempts = 0
    status.hidden = true
    screen.dataset.connected = 'true'
    notify('ready')
  })
  rfb.addEventListener('disconnect', () => {
    if (closed) return
    status.hidden = false
    screen.dataset.connected = 'false'
    if (reconnectAttempts < 8) {
      status.textContent = 'Reconnecting to Chrome…'
      reconnectTimer = window.setTimeout(connect, Math.min(30_000, 1000 * 2 ** reconnectAttempts++))
    } else {
      status.textContent = 'Chrome disconnected. Retry to reconnect.'
      notify('error', status.textContent)
    }
  })
  rfb.addEventListener('securityfailure', () => {
    closed = true
    window.clearTimeout(reconnectTimer)
    notify('error', 'Chrome could not establish a browser session.')
  })
  rfb.addEventListener('clipboard', (event) => {
    copiedText = event.detail.text
    clipboard.hidden = !copiedText
  })
}
let userControl = false
const showControl = (value) => {
  userControl = value.userControl
  control.textContent = userControl ? 'Let agent use browser' : 'Take control'
  control.setAttribute('aria-pressed', String(userControl))
}
control.addEventListener('click', async () => {
  control.disabled = true
  try {
    const response = await fetch('/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userControl: !userControl }),
    })
    if (!response.ok) throw new Error('Could not change browser control')
    showControl(await response.json())
    rfb.focus()
  } catch (error) {
    notify('error', error.message)
  } finally {
    control.disabled = false
  }
})
fetch('/control')
  .then((response) => {
    if (!response.ok) throw new Error('Browser control unavailable')
    return response.json()
  })
  .then(showControl)
  .catch((error) => notify('error', error.message))
document.addEventListener('pointerdown', () => notify('focus'), { capture: true })
const pasteText = async (text) => {
  const response = await fetch('/paste', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!response.ok) throw new Error('Could not paste into Chrome')
}
document.addEventListener(
  'paste',
  (event) => {
    const text = event.clipboardData?.getData('text/plain')
    if (!text) return
    event.preventDefault()
    pasteText(text).catch((error) => notify('error', error.message))
  },
  { capture: true },
)
let copiedText = ''
clipboard.addEventListener('click', async () => {
  await navigator.clipboard.writeText(copiedText)
  clipboard.hidden = true
  rfb.focus()
})
// Translate macOS Command shortcuts to the Linux browser's Control shortcuts.
document.addEventListener(
  'keydown',
  (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (!event.repeat)
        navigator.clipboard
          .readText()
          .then(pasteText)
          .catch((error) => {
            status.hidden = false
            status.textContent = `Paste requires clipboard access: ${error.message}`
          })
      return
    }
    if (event.key === 'Meta') {
      event.preventDefault()
      event.stopImmediatePropagation()
      return
    }
    if (!event.metaKey || event.key === 'Meta') return
    if (!/^[a-z0-9]$/i.test(event.key)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    rfb.sendKey(0xffe3, 'ControlLeft', true)
    rfb.sendKey(event.key.toLowerCase().charCodeAt(0), event.code)
    rfb.sendKey(0xffe3, 'ControlLeft', false)
  },
  { capture: true },
)
document.addEventListener(
  'keyup',
  (event) => {
    if (event.key === 'Meta') {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
  },
  { capture: true },
)
window.addEventListener('pagehide', () => {
  closed = true
  window.clearTimeout(reconnectTimer)
  rfb.disconnect()
})
connect()
