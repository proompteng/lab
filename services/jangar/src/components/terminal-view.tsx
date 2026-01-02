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
  const eventSourceRef = React.useRef<EventSource | null>(null)
  const resizeObserverRef = React.useRef<ResizeObserver | null>(null)
  const inputBufferRef = React.useRef('')
  const inputTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingEchoRef = React.useRef('')
  const pendingEchoTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const [status, setStatus] = React.useState<'connecting' | 'connected' | 'error'>('connecting')
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let isDisposed = false
    const decoder = new TextDecoder()

    const flushInput = () => {
      if (!inputBufferRef.current) return
      const data = inputBufferRef.current
      inputBufferRef.current = ''
      void fetch(`/api/terminals/${encodeURIComponent(sessionId)}/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: encodeInput(data) }),
      }).catch(() => undefined)
    }

    const scheduleInputFlush = () => {
      if (inputTimerRef.current) return
      inputTimerRef.current = setTimeout(() => {
        inputTimerRef.current = null
        flushInput()
      }, 16)
    }

    const schedulePendingEchoClear = () => {
      if (pendingEchoTimerRef.current) clearTimeout(pendingEchoTimerRef.current)
      pendingEchoTimerRef.current = setTimeout(() => {
        pendingEchoRef.current = ''
        pendingEchoTimerRef.current = null
      }, 750)
    }

    const applyLocalEcho = (terminal: import('xterm').Terminal, data: string) => {
      if (data.includes('\x1b')) return
      if (data === '\x7f') {
        if (pendingEchoRef.current.length > 0) {
          pendingEchoRef.current = pendingEchoRef.current.slice(0, -1)
        }
        terminal.write('\b \b')
        schedulePendingEchoClear()
        return
      }
      pendingEchoRef.current += data
      terminal.write(data)
      schedulePendingEchoClear()
    }

    const stripLocalEcho = (payload: string) => {
      const pending = pendingEchoRef.current
      if (!pending) return payload
      let index = 0
      const max = Math.min(pending.length, payload.length)
      while (index < max && pending[index] === payload[index]) index += 1
      if (index === 0) return payload
      pendingEchoRef.current = pending.slice(index)
      return payload.slice(index)
    }

    const sendResize = () => {
      const terminal = terminalRef.current
      if (!terminal) return
      void fetch(`/api/terminals/${encodeURIComponent(sessionId)}/resize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cols: terminal.cols, rows: terminal.rows }),
      }).catch(() => undefined)
    }

    const connect = async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('xterm'), import('xterm-addon-fit')])
      if (isDisposed || !containerRef.current) return

      const terminal = new Terminal({
        cursorBlink: true,
        convertEol: true,
        fontFamily:
          '"JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono"',
        fontSize: 12,
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
        inputBufferRef.current += data
        if (data.includes('\r')) {
          flushInput()
        } else {
          scheduleInputFlush()
        }
        applyLocalEcho(terminal, data)
      })

      resizeObserverRef.current = new ResizeObserver(() => {
        fitAddon.fit()
        sendResize()
      })
      resizeObserverRef.current.observe(containerRef.current)
      sendResize()

      const eventSource = new EventSource(`/api/terminals/${encodeURIComponent(sessionId)}/stream`)
      eventSourceRef.current = eventSource

      eventSource.onopen = () => {
        setStatus('connected')
      }

      eventSource.addEventListener('snapshot', (event) => {
        const payload = (event as MessageEvent).data
        if (!payload || !terminalRef.current) return
        const text = decoder.decode(base64ToBytes(payload))
        const output = stripLocalEcho(text)
        if (output) terminalRef.current.write(output)
      })

      eventSource.addEventListener('output', (event) => {
        const payload = (event as MessageEvent).data
        if (!payload || !terminalRef.current) return
        const text = decoder.decode(base64ToBytes(payload))
        const output = stripLocalEcho(text)
        if (output) terminalRef.current.write(output)
      })

      eventSource.addEventListener('server-error', (event) => {
        const payload = (event as MessageEvent).data
        if (payload) {
          setError(atob(payload))
        }
        setStatus('error')
      })

      eventSource.onerror = () => {
        setStatus('error')
        setError('Connection lost. Refresh to retry.')
        eventSource.close()
      }
    }

    void connect()

    return () => {
      isDisposed = true
      if (inputTimerRef.current) {
        clearTimeout(inputTimerRef.current)
        inputTimerRef.current = null
      }
      if (pendingEchoTimerRef.current) {
        clearTimeout(pendingEchoTimerRef.current)
        pendingEchoTimerRef.current = null
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close()
        eventSourceRef.current = null
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
