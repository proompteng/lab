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
  const inputFlushTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const snapshotTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const shouldReconnectRef = React.useRef(true)
  const resizeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSizeRef = React.useRef<{ cols: number; rows: number } | null>(null)
  const outputQueueRef = React.useRef<string[]>([])
  const snapshotApplyingRef = React.useRef(false)

  const [status, setStatus] = React.useState<'connecting' | 'connected' | 'error'>('connecting')
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let isDisposed = false
    const outputDecoder = new TextDecoder()
    const snapshotDecoder = new TextDecoder()
    shouldReconnectRef.current = true

    const buildSocketUrl = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const encoded = encodeURIComponent(sessionId)
      return `${protocol}://${window.location.host}/api/terminals/${encoded}/ws?sessionId=${encoded}`
    }

    const sendMessage = (payload: unknown) => {
      const socket = socketRef.current
      if (!socket || socket.readyState !== WebSocket.OPEN) return
      socket.send(JSON.stringify(payload))
    }

    const flushInput = () => {
      if (!inputBufferRef.current) return
      if (socketRef.current?.readyState !== WebSocket.OPEN) return
      const data = inputBufferRef.current
      inputBufferRef.current = ''
      sendMessage({ type: 'input', data: encodeInput(data) })
    }

    const sendResize = () => {
      const terminal = terminalRef.current
      if (!terminal) return
      sendMessage({ type: 'resize', cols: terminal.cols, rows: terminal.rows })
    }

    const scheduleSnapshot = (delayMs = 180) => {
      if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current)
      snapshotTimerRef.current = setTimeout(() => {
        snapshotTimerRef.current = null
        if (socketRef.current?.readyState === WebSocket.OPEN) {
          sendMessage({ type: 'snapshot' })
        }
      }, delayMs)
    }

    const refreshLayout = () => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = null
        const container = containerRef.current
        if (!container) return
        const { width, height } = container.getBoundingClientRect()
        if (width < 2 || height < 2) return
        const terminal = terminalRef.current
        const fitAddon = fitRef.current
        if (!terminal || !fitAddon) return

        fitAddon.fit()
        const nextSize = { cols: terminal.cols, rows: terminal.rows }
        const lastSize = lastSizeRef.current
        if (!lastSize || nextSize.cols !== lastSize.cols || nextSize.rows !== lastSize.rows) {
          lastSizeRef.current = nextSize
          sendResize()
          scheduleSnapshot()
        }
      }, 50)
    }

    const attachSocket = () => {
      if (socketRef.current) {
        socketRef.current.close()
      }

      const socket = new WebSocket(buildSocketUrl())
      socket.binaryType = 'arraybuffer'
      socketRef.current = socket

      socket.onopen = () => {
        reconnectAttemptRef.current = 0
        setStatus('connected')
        setError(null)
        refreshLayout()
        scheduleSnapshot()
        if (inputBufferRef.current) {
          flushInput()
        }
      }

      const flushQueuedOutput = () => {
        if (snapshotApplyingRef.current) return
        const terminal = terminalRef.current
        if (!terminal || outputQueueRef.current.length === 0) return
        const payload = outputQueueRef.current.join('')
        outputQueueRef.current = []
        terminal.write(payload)
      }

      const handleMessage = (raw: string) => {
        if (!terminalRef.current) return
        let payload: { type?: string; data?: string; message?: string; fatal?: boolean } | null = null
        try {
          payload = JSON.parse(raw)
        } catch {
          return
        }
        if (!payload) return
        if (payload.type === 'snapshot' && payload.data) {
          const terminal = terminalRef.current
          if (!terminal) return
          const text = snapshotDecoder.decode(base64ToBytes(payload.data))
          if (text) {
            snapshotApplyingRef.current = true
            terminal.write(`\u001b[2J\u001b[H${text}`, () => {
              snapshotApplyingRef.current = false
              terminal.scrollToBottom()
              terminal.focus()
              flushQueuedOutput()
            })
          }
          return
        }
        if (payload.type === 'output' && payload.data) {
          const text = outputDecoder.decode(base64ToBytes(payload.data))
          if (!text) return
          if (snapshotApplyingRef.current) {
            outputQueueRef.current.push(text)
            return
          }
          terminalRef.current.write(text)
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

      socket.onmessage = (event) => {
        if (typeof event.data === 'string') {
          handleMessage(event.data)
          return
        }
        if (event.data instanceof ArrayBuffer) {
          handleMessage(new TextDecoder().decode(new Uint8Array(event.data)))
          return
        }
        if (event.data instanceof Blob) {
          event.data
            .text()
            .then((text) => {
              handleMessage(text)
            })
            .catch(() => {})
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

      const handleFocus = () => {
        terminal.focus()
      }
      containerRef.current.addEventListener('pointerdown', handleFocus)

      terminal.onData((data: string) => {
        inputBufferRef.current += data
        if (inputBufferRef.current.length > 2048) {
          if (inputFlushTimerRef.current) {
            clearTimeout(inputFlushTimerRef.current)
            inputFlushTimerRef.current = null
          }
          if (socketRef.current?.readyState === WebSocket.OPEN) {
            flushInput()
          }
          return
        }
        if (socketRef.current?.readyState !== WebSocket.OPEN) return
        if (inputFlushTimerRef.current) return
        inputFlushTimerRef.current = setTimeout(() => {
          inputFlushTimerRef.current = null
          flushInput()
        }, 12)
      })

      resizeObserverRef.current = new ResizeObserver(() => {
        refreshLayout()
      })
      resizeObserverRef.current.observe(containerRef.current)
      sendResize()
      refreshLayout()

      const fonts = document.fonts?.ready
      if (fonts) {
        fonts.then(() => {
          refreshLayout()
        })
      }

      const handleVisibility = () => {
        if (document.visibilityState === 'visible') {
          refreshLayout()
          scheduleSnapshot(240)
        }
      }

      const handleWindowFocus = () => {
        refreshLayout()
        scheduleSnapshot(240)
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
        containerRef.current?.removeEventListener('pointerdown', handleFocus)
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
      if (snapshotTimerRef.current) {
        clearTimeout(snapshotTimerRef.current)
        snapshotTimerRef.current = null
      }
      if (inputFlushTimerRef.current) {
        clearTimeout(inputFlushTimerRef.current)
        inputFlushTimerRef.current = null
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

  const isConnecting = status === 'connecting'

  return (
    <div className="relative flex flex-col overflow-hidden h-full w-full rounded-none border border-border bg-black">
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs border-b border-border text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          Status: {status}
          {isConnecting ? (
            <span className="h-3 w-3 rounded-full border border-current border-t-transparent animate-spin" />
          ) : null}
        </span>
        {error ? <span className="text-destructive">{error}</span> : null}
      </div>
      <div ref={containerRef} className="flex flex-1 min-h-0" data-testid="terminal-canvas" />
      {isConnecting ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <span className="h-3 w-3 rounded-full border border-current border-t-transparent animate-spin" />
            Connecting to terminal...
          </div>
        </div>
      ) : null}
    </div>
  )
}
