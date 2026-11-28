;(() => {
  const desktopOrigin = __TENGRI_DESKTOP_ORIGIN__
  const sessionId = /^tengri-([a-z0-9]{24})\./.exec(location.hostname)?.[1]
  if (!sessionId || window.parent === window) return
  const channel = 'tengri-vscode-v1'
  let socket
  let disposed = false
  let reconnect
  const publish = (message) => window.parent.postMessage({ channel, sessionId, ...message }, desktopOrigin)
  const connect = () => {
    if (disposed) return
    const url = new URL('/_tengri/editor-bridge', location.href)
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('session', sessionId)
    socket = new WebSocket(url)
    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data)
        if (message.type === 'state' && typeof message.dirty === 'boolean') publish(message)
        else if (message.type === 'disconnected') publish(message)
        else if (message.type === 'result' && typeof message.id === 'string') publish(message)
      } catch {
        publish({ type: 'disconnected' })
      }
    })
    socket.addEventListener('close', (event) => {
      if (event.reason === 'editor superseded') disposed = true
      publish({ type: 'disconnected' })
      if (!disposed) reconnect = setTimeout(connect, 1000)
    })
  }
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== desktopOrigin) return
    const message = event.data
    if (message?.channel !== channel || message.sessionId !== sessionId) return
    if (message.type === 'open' && typeof message.path === 'string' && typeof message.id === 'string') {
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: 'open', id: message.id, path: message.path }))
    } else if (
      (message.type === 'close' || message.type === 'check') &&
      typeof message.id === 'string' &&
      socket?.readyState === WebSocket.OPEN
    ) {
      socket.send(JSON.stringify({ type: message.type, id: message.id }))
    } else if (message.type === 'state' && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'state' }))
    }
  })
  document.addEventListener('pointerdown', () => publish({ type: 'focus' }), { capture: true })
  window.addEventListener('pagehide', () => {
    disposed = true
    clearTimeout(reconnect)
    socket?.close()
  })
  connect()
})()
