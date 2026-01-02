import * as React from 'react'

const base64ToBytes = (value: string) => {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

const bytesToBase64 = (value: Uint8Array) => {
  let binary = ''
  for (let i = 0; i < value.length; i += 1) {
    binary += String.fromCharCode(value[i])
  }
  return btoa(binary)
}

const encodeInput = (value: string) => {
  const encoder = new TextEncoder()
  return bytesToBase64(encoder.encode(value))
}

type TerminalViewProps = {
  sessionId: string
}

export function TerminalView({ sessionId }: TerminalViewProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const terminalRef = React.useRef<import('xterm').Terminal | null>(null)
  const fitRef = React.useRef<import('xterm-addon-fit').FitAddon | null>(null)
  const socketRef = React.useRef<WebSocket | null>(null)
  const reconnectTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptRef = React.useRef(0)
  const resizeObserverRef = React.useRef<ResizeObserver | null>(null)
  const inputBufferRef = React.useRef('')
  const shouldReconnectRef = React.useRef(true)
  const resizeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const [status, setStatus] = React.useState<'connecting' | 'connected' | 'error'>('connecting')
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let isDisposed = false
    const decoder = new TextDecoder()
    shouldReconnectRef.current = true

    const buildSocketUrl = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
      return `${protocol}://${window.location.host}/api/terminals/${encodeURIComponent(sessionId)}/ws`
    }

    const sendMessage = (payload: unknown) => {
      const socket = socketRef.current
      if (!socket || socket.readyState !== WebSocket.OPEN) return
      socket.send(JSON.stringify(payload))
    }

    const flushInput = () => {
      if (!inputBufferRef.current) return
      const data = inputBufferRef.current
      inputBufferRef.current = ''
      sendMessage({ type: 'input', data: encodeInput(data) })
    }

    const sendResize = () => {
      const terminal = terminalRef.current
      if (!terminal) return
      sendMessage({ type: 'resize', cols: terminal.cols, rows: terminal.rows })
    }

    const refreshLayout = () => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = null
        const terminal = terminalRef.current
        const fitAddon = fitRef.current
        if (!terminal || !fitAddon) return
        fitAddon.fit()
        terminal.refresh(0, Math.max(0, terminal.rows - 1))
        sendResize()
      }, 50)
    }

    const attachSocket = () => {
      if (socketRef.current) {
        socketRef.current.close()
      }

      const socket = new WebSocket(buildSocketUrl())
      socketRef.current = socket

      socket.onopen = () => {
        reconnectAttemptRef.current = 0
        setStatus('connected')
        setError(null)
        sendResize()
        if (inputBufferRef.current) {
          flushInput()
        }
      }

      socket.onmessage = (event) => {
        if (!terminalRef.current) return
        if (typeof event.data !== 'string') return
        let payload: { type?: string; data?: string; message?: string; fatal?: boolean } | null = null
        try {
          payload = JSON.parse(event.data)
        } catch {
          return
        }
        if (!payload) return
        if (payload.type === 'snapshot' && payload.data) {
          const text = decoder.decode(base64ToBytes(payload.data))
          if (text) {
            terminalRef.current.reset()
            terminalRef.current.write(text)
          }
          return
        }
        if (payload.type === 'output' && payload.data) {
          const text = decoder.decode(base64ToBytes(payload.data))
          if (text) terminalRef.current.write(text)
          return
        }
        if (payload.type === 'error') {
          const message = payload.message ?? 'Terminal connection failed.'
          setError(message)
          if (payload.fatal) {
            setStatus('error')
            shouldReconnectRef.current = false
            socket.close()
          }
        }
      }

      socket.onerror = () => {
        if (!shouldReconnectRef.current) return
        setStatus('connecting')
        setError('Reconnecting...')
      }

      socket.onclose = () => {
        if (!shouldReconnectRef.current || isDisposed) return
        setStatus('connecting')
        setError('Reconnecting...')
        if (reconnectTimerRef.current) return
        const attempt = reconnectAttemptRef.current
        const delay = Math.min(10_000, 1000 * 2 ** attempt)
        reconnectAttemptRef.current += 1
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null
          if (!isDisposed && shouldReconnectRef.current) {
            attachSocket()
          }
        }, delay)
      }
    }

    const connect = async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('xterm'), import('xterm-addon-fit')])
      if (isDisposed || !containerRef.current) return

      const terminal = new Terminal({
        convertEol: true,
        cursorBlink: true,
        fontFamily:
          '"JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono"',
        fontSize: 12,
        scrollback: 2000,
        theme: {
          background: '#0b0d0f',
          foreground: '#e2e8f0',
          cursor: '#e2e8f0',
          selectionBackground: '#334155',
        },
      })

      const fitAddon = new FitAddon()
      terminal.loadAddon(fitAddon)
      terminal.open(containerRef.current)
      fitAddon.fit()
      terminal.focus()

      terminalRef.current = terminal
      fitRef.current = fitAddon

      terminal.onData((data: string) => {
        if (socketRef.current?.readyState === WebSocket.OPEN) {
          sendMessage({ type: 'input', data: encodeInput(data) })
          return
        }
        inputBufferRef.current += data
      })

      resizeObserverRef.current = new ResizeObserver(() => {
        refreshLayout()
      })
      resizeObserverRef.current.observe(containerRef.current)
      sendResize()
      refreshLayout()

      const handleVisibility = () => {
        if (document.visibilityState === 'visible') {
          refreshLayout()
        }
      }

      const handleWindowFocus = () => {
        refreshLayout()
      }

      const handleWindowResize = () => {
        refreshLayout()
      }

      document.addEventListener('visibilitychange', handleVisibility)
      window.addEventListener('focus', handleWindowFocus)
      window.addEventListener('resize', handleWindowResize)
      window.visualViewport?.addEventListener('resize', handleWindowResize)

      attachSocket()

      return () => {
        document.removeEventListener('visibilitychange', handleVisibility)
        window.removeEventListener('focus', handleWindowFocus)
        window.removeEventListener('resize', handleWindowResize)
        window.visualViewport?.removeEventListener('resize', handleWindowResize)
      }
    }

    let cleanupListeners: (() => void) | null = null
    void connect().then((cleanup) => {
      if (cleanup) cleanupListeners = cleanup
    })

    return () => {
      isDisposed = true
      shouldReconnectRef.current = false
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current)
        resizeTimerRef.current = null
      }
      if (socketRef.current) {
        socketRef.current.close()
        socketRef.current = null
      }
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect()
        resizeObserverRef.current = null
      }
      if (terminalRef.current) {
        terminalRef.current.dispose()
        terminalRef.current = null
      }
      fitRef.current = null
      if (cleanupListeners) {
        cleanupListeners()
        cleanupListeners = null
      }
    }
  }, [sessionId])

  return (
    <div className="flex flex-col overflow-hidden h-full w-full rounded-none border border-border bg-black">
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs border-b border-border text-muted-foreground">
        <span>Status: {status}</span>
        {error ? <span className="text-destructive">{error}</span> : null}
      </div>
      <div ref={containerRef} className="flex flex-1 min-h-0" />
    </div>
  )
}
