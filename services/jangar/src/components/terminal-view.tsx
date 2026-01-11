import '@xterm/xterm/css/xterm.css'

import { CanvasAddon } from '@xterm/addon-canvas'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { FitAddon } from '@xterm/addon-fit'
import { ImageAddon } from '@xterm/addon-image'
import { LigaturesAddon } from '@xterm/addon-ligatures'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { randomUuid } from '@/lib/uuid'

const OUTPUT_FRAME_TYPE = 1
const RECONNECT_STORAGE_KEY = 'jangar-terminal-reconnect'
const TERMINAL_FONT_FAMILY =
  '"JetBrains Mono Nerd Font", "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'

const buildWsUrl = (
  baseUrl: string,
  sessionId: string,
  reconnectToken: string,
  since: number,
  cols?: number,
  rows?: number,
  sessionToken?: string | null,
) => {
  const url = new URL(baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  if (!url.pathname.endsWith('/')) {
    url.pathname += '/'
  }
  url.pathname += `api/terminals/${encodeURIComponent(sessionId)}/ws`
  url.searchParams.set('reconnect', reconnectToken)
  if (sessionToken) url.searchParams.set('token', sessionToken)
  if (since > 0) url.searchParams.set('since', `${since}`)
  if (cols) url.searchParams.set('cols', `${cols}`)
  if (rows) url.searchParams.set('rows', `${rows}`)
  return url.toString()
}

const resolveBaseUrl = (terminalUrl?: string | null) => {
  if (terminalUrl) return terminalUrl
  return window.location.origin
}

type TerminalViewProps = {
  sessionId: string
  terminalUrl?: string | null
  variant?: 'default' | 'fullscreen'
  reconnectToken?: string | null
  className?: string
}

export function TerminalView({
  sessionId,
  terminalUrl,
  variant = 'default',
  reconnectToken,
  className,
}: TerminalViewProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const terminalRef = React.useRef<Terminal | null>(null)
  const fitRef = React.useRef<FitAddon | null>(null)
  const searchRef = React.useRef<SearchAddon | null>(null)
  const socketRef = React.useRef<WebSocket | null>(null)
  const reconnectTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptRef = React.useRef(0)
  const resizeObserverRef = React.useRef<ResizeObserver | null>(null)
  const lastSeqRef = React.useRef(0)
  const reconnectTokenRef = React.useRef('')
  const sessionTokenRef = React.useRef<string | null>(null)
  const statusRef = React.useRef<'connecting' | 'connected' | 'error'>('connecting')
  const decoderRef = React.useRef(new TextDecoder())
  const encoderRef = React.useRef(new TextEncoder())

  const [status, setStatus] = React.useState<'connecting' | 'connected' | 'error'>('connecting')
  const [error, setError] = React.useState<string | null>(null)
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [searchValue, setSearchValue] = React.useState('')

  React.useEffect(() => {
    reconnectTokenRef.current = ''
    lastSeqRef.current = 0
    sessionTokenRef.current = null

    const saved = window.sessionStorage.getItem(`${RECONNECT_STORAGE_KEY}-${sessionId}`)
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as { token?: string; seq?: number; sessionToken?: string | null }
        if (parsed.token) reconnectTokenRef.current = parsed.token
        if (typeof parsed.seq === 'number') lastSeqRef.current = parsed.seq
        if (parsed.sessionToken) sessionTokenRef.current = parsed.sessionToken
      } catch {
        // ignore
      }
    }

    if (reconnectToken) {
      sessionTokenRef.current = reconnectToken
    }

    if (!reconnectTokenRef.current) {
      reconnectTokenRef.current = randomUuid()
    }

    const persist = () => {
      window.sessionStorage.setItem(
        `${RECONNECT_STORAGE_KEY}-${sessionId}`,
        JSON.stringify({
          token: reconnectTokenRef.current,
          seq: lastSeqRef.current,
          sessionToken: sessionTokenRef.current,
        }),
      )
    }
    persist()
  }, [sessionId, reconnectToken])

  React.useEffect(() => {
    if (!containerRef.current) return

    const terminal = new Terminal({
      allowProposedApi: true,
      allowTransparency: true,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: 14,
      theme: { background: 'rgba(0,0,0,0)' },
      cursorBlink: true,
      scrollback: 5000,
    })

    const fitAddon = new FitAddon()
    fitRef.current = fitAddon
    terminal.loadAddon(fitAddon)

    const unicodeAddon = new Unicode11Addon()
    terminal.loadAddon(unicodeAddon)
    terminal.unicode.activeVersion = '11'

    terminal.loadAddon(
      new WebLinksAddon((_event, uri) => {
        window.open(uri, '_blank', 'noopener,noreferrer')
      }),
    )

    const clipboardAddon = new ClipboardAddon()
    terminal.loadAddon(clipboardAddon)

    const searchAddon = new SearchAddon()
    terminal.loadAddon(searchAddon)
    searchRef.current = searchAddon

    terminal.loadAddon(new SerializeAddon())

    try {
      terminal.loadAddon(new LigaturesAddon())
    } catch {
      // ignore
    }

    try {
      terminal.loadAddon(new ImageAddon())
    } catch {
      // ignore
    }

    const rendererPreference = (() => {
      const params = new URLSearchParams(window.location.search)
      const query = params.get('renderer')?.toLowerCase()
      const stored = window.localStorage.getItem('jangar-terminal-renderer')
      if (query) return { value: query, fromQuery: true }
      if (stored) return { value: stored, fromQuery: false }
      return { value: 'canvas', fromQuery: false }
    })()

    const needsCanvasRenderer = rendererPreference.value === 'dom'
    if (needsCanvasRenderer && !rendererPreference.fromQuery) {
      window.localStorage.setItem('jangar-terminal-renderer', 'canvas')
    }

    const renderer = needsCanvasRenderer ? 'canvas' : rendererPreference.value

    if (renderer === 'webgl') {
      try {
        terminal.loadAddon(new WebglAddon())
      } catch {
        terminal.loadAddon(new CanvasAddon())
      }
    } else if (renderer === 'canvas') {
      terminal.loadAddon(new CanvasAddon())
    }

    terminal.attachCustomKeyEventHandler((event) => {
      const isMac = navigator.platform.match('Mac')
      const ctrlKey = isMac ? event.metaKey : event.ctrlKey
      if (event.shiftKey && event.key === 'Enter') {
        if (event.type === 'keydown') {
          if (socketRef.current?.readyState === WebSocket.OPEN) {
            socketRef.current.send(encoderRef.current.encode('\x1b\r'))
          }
        }
        return false
      }
      if (ctrlKey && event.shiftKey && event.key.toLowerCase() === 'c') {
        if (event.type === 'keydown') {
          const selection = terminal.getSelection()
          if (selection) {
            navigator.clipboard?.writeText(selection).catch(() => {})
          }
        }
        return false
      }
      if (ctrlKey && event.shiftKey && event.key.toLowerCase() === 'v') {
        if (event.type === 'keydown') {
          navigator.clipboard
            ?.readText()
            .then((text) => {
              if (text) {
                terminal.paste(text)
              }
            })
            .catch(() => {})
        }
        return false
      }
      if (ctrlKey && event.key.toLowerCase() === 'f') {
        if (event.type === 'keydown') {
          setSearchOpen(true)
        }
        return false
      }
      return true
    })

    terminal.onSelectionChange(() => {
      const selection = terminal.getSelection()
      if (selection) {
        navigator.clipboard?.writeText(selection).catch(() => {})
      }
    })

    terminal.open(containerRef.current)
    containerRef.current.style.fontFamily = TERMINAL_FONT_FAMILY
    fitAddon.fit()
    fitAddon.fit()
    if ('fonts' in document) {
      void document.fonts
        .load(`14px ${TERMINAL_FONT_FAMILY}`)
        .then(() => {
          if (containerRef.current) {
            containerRef.current.style.fontFamily = TERMINAL_FONT_FAMILY
          }
          terminal.options.fontFamily = TERMINAL_FONT_FAMILY
          fitAddon.fit()
          terminal.refresh(0, terminal.rows - 1)
        })
        .catch(() => {})
    }
    if (containerRef.current) {
      containerRef.current.dataset.termCols = String(terminal.cols)
      containerRef.current.dataset.termRows = String(terminal.rows)
    }
    const container = containerRef.current
    const focusTerminal = () => terminal.focus()
    if (container) {
      container.addEventListener('pointerdown', focusTerminal)
      container.addEventListener('focus', focusTerminal)
    }
    terminalRef.current = terminal

    terminal.onData((data) => {
      if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return
      const payload = encoderRef.current.encode(data)
      socketRef.current.send(payload)
    })

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
      const cols = terminal.cols
      const rows = terminal.rows
      if (containerRef.current) {
        containerRef.current.dataset.termCols = String(cols)
        containerRef.current.dataset.termRows = String(rows)
      }
      if (cols > 0 && rows > 0) {
        const payload = JSON.stringify({ type: 'resize', cols, rows })
        if (socketRef.current?.readyState === WebSocket.OPEN) {
          socketRef.current.send(payload)
        }
      }
    })
    resizeObserver.observe(containerRef.current)
    resizeObserverRef.current = resizeObserver

    return () => {
      if (container) {
        container.removeEventListener('pointerdown', focusTerminal)
        container.removeEventListener('focus', focusTerminal)
      }
      resizeObserver.disconnect()
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
      searchRef.current = null
    }
  }, [])

  React.useEffect(() => {
    let disposed = false

    const connect = () => {
      if (disposed) return
      const terminal = terminalRef.current
      const fitAddon = fitRef.current
      if (!terminal || !fitAddon) return

      const cols = terminal.cols
      const rows = terminal.rows
      const baseUrl = resolveBaseUrl(terminalUrl)
      const sessionToken = reconnectToken ?? sessionTokenRef.current
      const wsUrl = buildWsUrl(
        baseUrl,
        sessionId,
        reconnectTokenRef.current,
        lastSeqRef.current,
        cols,
        rows,
        sessionToken,
      )
      const socket = new WebSocket(wsUrl)
      socket.binaryType = 'arraybuffer'
      socketRef.current = socket

      setStatus('connecting')
      statusRef.current = 'connecting'

      socket.onopen = () => {
        reconnectAttemptRef.current = 0
        setStatus('connected')
        statusRef.current = 'connected'
        setError(null)
        decoderRef.current = new TextDecoder()
        if (fitAddon) fitAddon.fit()
        const payload = JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows })
        socket.send(payload)
      }

      socket.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try {
            const payload = JSON.parse(event.data) as { type?: string; message?: string; token?: string }
            if (payload.type === 'error') {
              setError(payload.message ?? 'Terminal error')
              setStatus('error')
              statusRef.current = 'error'
            }
            if (payload.type === 'ready' && payload.token) {
              reconnectTokenRef.current = payload.token
              window.sessionStorage.setItem(
                `${RECONNECT_STORAGE_KEY}-${sessionId}`,
                JSON.stringify({
                  token: reconnectTokenRef.current,
                  seq: lastSeqRef.current,
                  sessionToken: sessionTokenRef.current,
                }),
              )
            }
            if (payload.type === 'reset') {
              terminal.reset()
              terminal.clear()
              lastSeqRef.current = 0
              decoderRef.current = new TextDecoder()
            }
            if (payload.type === 'exit') {
              setStatus('error')
              statusRef.current = 'error'
              setError('Terminal session exited.')
            }
          } catch {
            // ignore
          }
          return
        }
        const data = new Uint8Array(event.data)
        if (data.length < 6 || data[0] !== OUTPUT_FRAME_TYPE) return
        const seq = ((data[1] << 24) | (data[2] << 16) | (data[3] << 8) | data[4]) >>> 0
        const payload = data.subarray(5)
        const text = decoderRef.current.decode(payload, { stream: true })
        terminal.write(text)
        lastSeqRef.current = seq
        window.sessionStorage.setItem(
          `${RECONNECT_STORAGE_KEY}-${sessionId}`,
          JSON.stringify({
            token: reconnectTokenRef.current,
            seq: lastSeqRef.current,
            sessionToken: sessionTokenRef.current,
          }),
        )
      }

      socket.onclose = () => {
        socketRef.current = null
        if (disposed) return
        if (statusRef.current !== 'error') {
          setStatus('connecting')
          statusRef.current = 'connecting'
        }
        const attempt = reconnectAttemptRef.current + 1
        reconnectAttemptRef.current = attempt
        const delay = Math.min(8000, 600 + attempt * 500)
        reconnectTimerRef.current = setTimeout(connect, delay)
      }

      socket.onerror = () => {
        setStatus('error')
        statusRef.current = 'error'
        setError('WebSocket error')
      }
    }

    connect()

    return () => {
      disposed = true
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      socketRef.current?.close()
      socketRef.current = null
    }
  }, [sessionId, terminalUrl, reconnectToken])

  const isConnecting = status === 'connecting'

  return (
    <div
      className={cn(
        'relative flex flex-col overflow-hidden h-full w-full bg-black',
        variant === 'default' && 'rounded-none border border-border',
        className,
      )}
    >
      {variant === 'default' ? (
        <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs border-b border-border text-muted-foreground">
          <span className="inline-flex items-center gap-2">
            Status: {status}
            {isConnecting ? (
              <span className="h-3 w-3 rounded-full border border-current border-t-transparent animate-spin" />
            ) : null}
          </span>
          {error ? <span className="text-destructive">{error}</span> : null}
        </div>
      ) : null}
      <div
        ref={containerRef}
        className="flex flex-1 min-h-0 bg-transparent outline-none focus-within:ring-2 focus-within:ring-zinc-500/70 focus-within:ring-inset"
        data-testid="terminal-canvas"
        role="application"
        aria-label="Terminal"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: xterm mounts its own input; container must be focusable.
        tabIndex={0}
      />
      {isConnecting ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <span className="h-3 w-3 rounded-full border border-current border-t-transparent animate-spin" />
            Connecting to terminal...
          </div>
        </div>
      ) : null}
      {searchOpen ? (
        <div className="absolute right-4 top-4 flex items-center gap-2 rounded-none border border-border bg-card px-3 py-2 text-xs shadow-lg">
          <input
            className="min-w-[180px] bg-transparent text-xs text-foreground outline-none"
            placeholder="Search"
            value={searchValue}
            onChange={(event) => setSearchValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                searchRef.current?.findNext(searchValue)
              }
              if (event.key === 'Escape') {
                setSearchOpen(false)
              }
            }}
          />
          <Button size="sm" variant="ghost" onClick={() => searchRef.current?.findPrevious(searchValue)}>
            Prev
          </Button>
          <Button size="sm" variant="ghost" onClick={() => searchRef.current?.findNext(searchValue)}>
            Next
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSearchOpen(false)}>
            Close
          </Button>
        </div>
      ) : null}
    </div>
  )
}
