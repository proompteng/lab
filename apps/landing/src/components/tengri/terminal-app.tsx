'use client'

import '@xterm/xterm/css/xterm.css'

import type { SearchAddon } from '@xterm/addon-search'
import type { Terminal } from '@xterm/xterm'
import { AlertTriangle, ChevronDown, ChevronUp, LoaderCircle, RotateCw, Search, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import type { TengriTerminalSession, TengriTerminalTicket } from '@/lib/tengri/types'

import { runTengriAction } from './client'
import {
  buildTerminalWebSocketUrl,
  normalizeTerminalSize,
  parseTerminalCleanupState,
  parseTerminalControlFrame,
  parseTerminalOutputFrame,
  parseTerminalResumeState,
  safelyDisposeTerminal,
  settleTerminalCreation,
  terminalHeartbeatAction,
  terminalPlainText,
  terminalReconnectDelay,
  terminalResumeAttachment,
  terminalTicketProtocol,
  type TerminalResumeState,
} from './terminal-protocol'

type ConnectionState = {
  phase: 'connected' | 'connecting' | 'error' | 'exited' | 'initializing' | 'reconnecting'
  message: string
  action: 'new' | 'reconnect' | null
}

const encoder = new TextEncoder()

export function TerminalApp({ agentId }: { agentId: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const reconnectNowRef = useRef<() => void>(() => undefined)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const instanceId = useId().replaceAll(/[^a-zA-Z0-9_-]/g, '')
  const storageKey = `tengri:terminal:${agentId}:${instanceId}`
  const cleanupStorageKey = `tengri:terminal-cleanup:${agentId}`
  const [connection, setConnection] = useState<ConnectionState>({
    phase: 'initializing',
    message: 'Starting Terminal…',
    action: null,
  })
  const [renderer, setRenderer] = useState<'canvas' | 'dom' | 'loading'>('loading')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchValue, setSearchValue] = useState('')
  const [run, setRun] = useState(0)

  useEffect(() => {
    if (!searchOpen) return
    const frame = requestAnimationFrame(() => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [searchOpen])

  useEffect(() => {
    let disposed = false
    let terminalEnded = false
    let connecting = false
    let session: TengriTerminalSession | null = null
    let socket: WebSocket | null = null
    let reconnectToken = ''
    let lastSequence = 0
    let reconnectAttempt = 0
    let reconnectTimer: number | null = null
    let heartbeatTimer: number | null = null
    let resizeFrame: number | null = null
    let persistFrame: number | null = null
    let lastHeartbeatTickAt = Date.now()
    let waitingForPongSince: number | null = null
    let resizeObserver: ResizeObserver | null = null
    let cleanupChecked = false
    let resumeChecked = false
    const controller = new AbortController()
    const disposables: Array<{ dispose(): void }> = []
    const requestSignal = () => AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])

    const updateConnection = (next: ConnectionState) => {
      if (!disposed) setConnection(next)
    }
    updateConnection({ phase: 'initializing', message: 'Starting Terminal…', action: null })
    setRenderer('loading')

    const resumeState = (): TerminalResumeState | null => {
      try {
        return parseTerminalResumeState(sessionStorage.getItem(storageKey), agentId)
      } catch {
        return null
      }
    }

    const pendingCleanupIds = (): string[] => {
      try {
        return parseTerminalCleanupState(sessionStorage.getItem(cleanupStorageKey), agentId)?.sessionIds ?? []
      } catch {
        return []
      }
    }

    const writePendingCleanupIds = (sessionIds: string[]) => {
      try {
        if (sessionIds.length === 0) sessionStorage.removeItem(cleanupStorageKey)
        else sessionStorage.setItem(cleanupStorageKey, JSON.stringify({ agentId, sessionIds }))
      } catch {
        // Cleanup still proceeds immediately when storage is unavailable.
      }
    }

    const recordPendingCleanup = (sessionId: string) => {
      writePendingCleanupIds([...new Set([...pendingCleanupIds(), sessionId])])
    }

    const clearPendingCleanup = (sessionId: string) => {
      writePendingCleanupIds(pendingCleanupIds().filter((candidate) => candidate !== sessionId))
    }

    const storeSession = (current: TengriTerminalSession, cleanupPending: boolean) => {
      try {
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({
            agentId,
            sessionId: current.id,
            reconnectToken,
            sequence: lastSequence,
            cleanupPending,
          }),
        )
      } catch {
        // The PTY remains usable if private browsing disables session storage.
      }
    }

    const persist = () => {
      if (!session || disposed) return
      storeSession(session, false)
    }

    const schedulePersist = () => {
      if (persistFrame !== null) return
      persistFrame = requestAnimationFrame(() => {
        persistFrame = null
        persist()
      })
    }

    const clearStoredSession = (sessionId?: string) => {
      try {
        const stored = resumeState()
        if (sessionId && stored && stored.sessionId !== sessionId) return
        sessionStorage.removeItem(storageKey)
      } catch {
        // Storage is optional.
      }
    }

    const stopHeartbeat = () => {
      if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }

    const startHeartbeat = (target: WebSocket) => {
      stopHeartbeat()
      lastHeartbeatTickAt = Date.now()
      waitingForPongSince = null
      heartbeatTimer = window.setInterval(() => {
        if (disposed || socket !== target || target.readyState !== WebSocket.OPEN) return
        const now = Date.now()
        const action = terminalHeartbeatAction(now, lastHeartbeatTickAt, waitingForPongSince)
        lastHeartbeatTickAt = now
        if (action === 'close') {
          target.close(4_000, 'Terminal heartbeat timed out')
          return
        }
        if (action === 'ping') {
          waitingForPongSince = now
          target.send('{"type":"ping"}')
        }
      }, 15_000)
    }

    const markAlive = () => {
      waitingForPongSince = null
    }

    async function terminateAndClear(current: TengriTerminalSession, keepalive = false) {
      await runTengriAction(
        { action: 'terminate-terminal', agentId, terminalId: current.id },
        keepalive ? { keepalive: true } : requestSignal(),
      )
      clearPendingCleanup(current.id)
      clearStoredSession(current.id)
    }

    const terminalSize = () => normalizeTerminalSize(terminalRef.current?.cols ?? 120, terminalRef.current?.rows ?? 32)

    const sendResize = () => {
      const target = socket
      if (target?.readyState !== WebSocket.OPEN) return
      const { columns, rows } = terminalSize()
      target.send(JSON.stringify({ type: 'resize', cols: columns, rows }))
    }

    const fit = (fitAddon: { fit(): void }) => {
      try {
        fitAddon.fit()
        sendResize()
      } catch {
        // A zero-sized window will be fitted again by ResizeObserver after restoration.
      }
    }

    async function ensureSession(terminal: Terminal): Promise<TengriTerminalSession> {
      if (session) return session
      if (!cleanupChecked) {
        const pending = pendingCleanupIds()
        if (pending.length > 0) {
          const sessions = await runTengriAction<TengriTerminalSession[]>(
            { action: 'list-terminals', agentId },
            requestSignal(),
          )
          for (const sessionId of pending) {
            const existing = sessions.find((candidate) => candidate.id === sessionId)
            if (existing) await terminateAndClear(existing)
            else clearPendingCleanup(sessionId)
          }
        }
        cleanupChecked = true
      }
      if (!resumeChecked) {
        const stored = resumeState()
        if (stored) {
          const sessions = await runTengriAction<TengriTerminalSession[]>(
            { action: 'list-terminals', agentId },
            requestSignal(),
          )
          const existing = sessions.find((candidate) => candidate.id === stored.sessionId)
          if (existing && stored.cleanupPending) {
            await terminateAndClear(existing)
          } else if (existing) {
            session = existing
            const restored = terminalResumeAttachment(stored, existing.attached)
            reconnectToken = restored.reconnectToken
            lastSequence = restored.sequence
          } else {
            clearStoredSession(stored.sessionId)
          }
        }
        resumeChecked = true
      }
      if (!session) {
        const { columns, rows } = normalizeTerminalSize(terminal.cols, terminal.rows)
        session = await settleTerminalCreation(
          runTengriAction<TengriTerminalSession>({
            action: 'create-terminal',
            agentId,
            cwd: '/workspace',
            columns,
            rows,
          }),
          () => disposed,
          async (created) => {
            recordPendingCleanup(created.id)
            storeSession(created, true)
            await terminateAndClear(created, true).catch(() => undefined)
          },
        )
        reconnectToken = ''
        lastSequence = 0
      }
      persist()
      return session
    }

    async function reconcileSession() {
      const current = session
      if (!current || disposed) return
      try {
        const sessions = await runTengriAction<TengriTerminalSession[]>(
          { action: 'list-terminals', agentId },
          requestSignal(),
        )
        if (sessions.some((candidate) => candidate.id === current.id)) return
        clearStoredSession(current.id)
        session = null
        reconnectToken = ''
        lastSequence = 0
        resumeChecked = true
      } catch {
        // Keep the known session after a transient control-plane failure.
      }
    }

    function scheduleReconnect(reason = '') {
      if (disposed || terminalEnded || reconnectTimer !== null) return
      reconnectAttempt += 1
      updateConnection({
        phase: 'reconnecting',
        message: reason ? `Reconnecting — ${reason}` : 'Reconnecting Terminal…',
        action: 'reconnect',
      })
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null
        void connect()
      }, terminalReconnectDelay(reconnectAttempt))
    }

    function reconnectNow() {
      if (disposed || terminalEnded) return
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
      reconnectTimer = null
      if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
        socket.close(4_001, 'Manual reconnect')
        return
      }
      void connect()
    }

    reconnectNowRef.current = reconnectNow

    async function connect() {
      const terminal = terminalRef.current
      if (disposed || terminalEnded || connecting || !terminal) return
      if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return
      connecting = true
      updateConnection({
        phase: reconnectAttempt ? 'reconnecting' : 'connecting',
        message: reconnectAttempt ? 'Reconnecting Terminal…' : 'Connecting Terminal…',
        action: reconnectAttempt ? 'reconnect' : null,
      })
      try {
        const activeSession = await ensureSession(terminal)
        const ticket = await runTengriAction<TengriTerminalTicket>(
          { action: 'terminal-ticket', agentId, terminalId: activeSession.id },
          requestSignal(),
        )
        if (disposed || terminalEnded) return
        const { columns, rows } = terminalSize()
        const url = buildTerminalWebSocketUrl(ticket.websocketUrl, {
          reconnectToken,
          sequence: lastSequence,
          columns,
          rows,
        })
        const protocol = terminalTicketProtocol(ticket.ticket)
        const nextSocket = new WebSocket(url, [protocol])
        nextSocket.binaryType = 'arraybuffer'
        socket = nextSocket

        const handleOutput = (data: ArrayBuffer | Uint8Array) => {
          if (disposed || socket !== nextSocket || terminalEnded) return
          const frame = parseTerminalOutputFrame(data)
          if (!frame || frame.sequence <= lastSequence) return
          markAlive()
          lastSequence = frame.sequence
          terminal.write(frame.payload)
          schedulePersist()
        }

        nextSocket.addEventListener('open', () => {
          if (disposed || socket !== nextSocket) return
          if (nextSocket.protocol !== protocol) {
            nextSocket.close(1_002, 'Terminal ticket protocol was not acknowledged')
            return
          }
          sendResize()
          startHeartbeat(nextSocket)
        })
        nextSocket.addEventListener('message', (event) => {
          if (disposed || socket !== nextSocket || terminalEnded) return
          markAlive()
          if (typeof event.data === 'string') {
            const control = parseTerminalControlFrame(event.data)
            if (!control) return
            if (control.type === 'ready') {
              reconnectAttempt = 0
              reconnectToken = control.token
              updateConnection({ phase: 'connected', message: 'Connected', action: null })
              schedulePersist()
            } else if (control.type === 'reset') {
              lastSequence = 0
              terminal.reset()
              terminal.clear()
              terminal.write('\r\n\x1b[33m[Terminal output replay restarted]\x1b[0m\r\n')
              schedulePersist()
            } else if (control.type === 'pong') {
              markAlive()
            } else if (control.type === 'error') {
              const message = control.message || 'Terminal reported an error'
              updateConnection({ phase: 'error', message, action: 'reconnect' })
              terminal.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`)
            } else if (control.type === 'exit') {
              terminalEnded = true
              const current = session
              session = null
              if (current) clearPendingCleanup(current.id)
              clearStoredSession(current?.id)
              stopHeartbeat()
              const message = control.exitCode === 0 ? 'Terminal exited' : `Terminal exited (${control.exitCode})`
              terminal.write(`\r\n\x1b[90m[${message}]\x1b[0m\r\n`)
              updateConnection({ phase: 'exited', message, action: 'new' })
              nextSocket.close(1_000, 'Terminal exited')
            }
            return
          }
          if (event.data instanceof ArrayBuffer) {
            handleOutput(event.data)
          } else if (event.data instanceof Blob) {
            void event.data
              .arrayBuffer()
              .then(handleOutput)
              .catch(() => undefined)
          }
        })
        nextSocket.addEventListener('close', () => {
          if (socket !== nextSocket) return
          socket = null
          stopHeartbeat()
          if (!disposed && !terminalEnded) scheduleReconnect()
        })
        nextSocket.addEventListener('error', () => {
          if (disposed || socket !== nextSocket) return
          updateConnection({ phase: 'error', message: 'Terminal connection failed', action: 'reconnect' })
          nextSocket.close()
        })
      } catch (cause) {
        if (disposed || controller.signal.aborted) return
        await reconcileSession()
        const message = terminalPlainText(cause instanceof Error ? cause.message : '') || 'Terminal could not connect'
        updateConnection({ phase: 'error', message, action: 'reconnect' })
        scheduleReconnect(message)
      } finally {
        connecting = false
      }
    }

    async function start() {
      if (!hostRef.current) return
      const [xterm, fitModule, search, unicode] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-search'),
        import('@xterm/addon-unicode11'),
      ])
      if (disposed || !hostRef.current) return
      const terminal = new xterm.Terminal({
        allowProposedApi: true,
        cursorBlink: true,
        cursorInactiveStyle: 'outline',
        cursorStyle: 'bar',
        fontFamily: 'JetBrains Mono, SFMono-Regular, Menlo, monospace',
        fontSize: 13,
        letterSpacing: 0,
        lineHeight: 1.2,
        rightClickSelectsWord: true,
        scrollback: 10_000,
        theme: {
          background: '#0a0c10',
          foreground: '#d9e0ee',
          cursor: '#9ccfd8',
          selectionBackground: '#3e4c76aa',
          black: '#252936',
          red: '#eb6f92',
          green: '#9ccfd8',
          yellow: '#f6c177',
          blue: '#78a9ff',
          magenta: '#c4a7e7',
          cyan: '#7dcfff',
          white: '#e0def4',
        },
      })
      terminalRef.current = terminal
      const fitAddon = new fitModule.FitAddon()
      const searchAddon = new search.SearchAddon()
      searchAddonRef.current = searchAddon
      terminal.loadAddon(fitAddon)
      terminal.loadAddon(searchAddon)
      const unicodeAddon = new unicode.Unicode11Addon()
      terminal.loadAddon(unicodeAddon)
      terminal.unicode.activeVersion = '11'
      terminal.open(hostRef.current)

      const [canvasModule, clipboardModule, imageModule, webLinksModule] = await Promise.allSettled([
        import('@xterm/addon-canvas'),
        import('@xterm/addon-clipboard'),
        import('@xterm/addon-image'),
        import('@xterm/addon-web-links'),
      ])
      if (disposed) return
      if (canvasModule.status === 'fulfilled') {
        try {
          terminal.loadAddon(new canvasModule.value.CanvasAddon())
          setRenderer('canvas')
        } catch (cause) {
          console.warn('[tengri-terminal] canvas renderer unavailable; using DOM fallback', cause)
          setRenderer('dom')
        }
      } else {
        console.warn('[tengri-terminal] canvas renderer unavailable; using DOM fallback', canvasModule.reason)
        setRenderer('dom')
      }
      if (clipboardModule.status === 'fulfilled') {
        try {
          terminal.loadAddon(new clipboardModule.value.ClipboardAddon())
        } catch (cause) {
          console.warn('[tengri-terminal] clipboard addon unavailable', cause)
        }
      } else {
        console.warn('[tengri-terminal] clipboard addon unavailable', clipboardModule.reason)
      }
      if (imageModule.status === 'fulfilled') {
        try {
          terminal.loadAddon(new imageModule.value.ImageAddon())
        } catch (cause) {
          console.warn('[tengri-terminal] image addon unavailable', cause)
        }
      } else {
        console.warn('[tengri-terminal] image addon unavailable', imageModule.reason)
      }
      if (webLinksModule.status === 'fulfilled') {
        try {
          terminal.loadAddon(
            new webLinksModule.value.WebLinksAddon((_event, uri) => window.open(uri, '_blank', 'noopener,noreferrer')),
          )
        } catch (cause) {
          console.warn('[tengri-terminal] web links addon unavailable', cause)
        }
      } else {
        console.warn('[tengri-terminal] web links addon unavailable', webLinksModule.reason)
      }

      const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
      terminal.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown') return true
        const primary = isMac ? event.metaKey : event.ctrlKey
        const clipboardShortcut = isMac ? primary && !event.shiftKey : event.ctrlKey && event.shiftKey
        if (primary && event.key.toLowerCase() === 'f') {
          setSearchOpen(true)
          return false
        }
        if (clipboardShortcut && event.key.toLowerCase() === 'c') {
          const selected = terminal.getSelection()
          if (selected) void navigator.clipboard?.writeText(selected)
          return false
        }
        if (clipboardShortcut && event.key.toLowerCase() === 'v') {
          void navigator.clipboard
            ?.readText()
            .then((value) => value && terminal.paste(value))
            .catch(() => undefined)
          return false
        }
        return true
      })

      const focusTerminal = () => terminal.focus()
      const host = hostRef.current
      host.addEventListener('pointerdown', focusTerminal)
      host.addEventListener('focus', focusTerminal)
      disposables.push(
        { dispose: () => host.removeEventListener('pointerdown', focusTerminal) },
        { dispose: () => host.removeEventListener('focus', focusTerminal) },
        terminal.onData((data) => {
          if (socket?.readyState === WebSocket.OPEN) socket.send(encoder.encode(data))
        }),
        terminal.onResize(sendResize),
      )

      fit(fitAddon)
      resizeObserver = new ResizeObserver(() => {
        if (resizeFrame !== null) return
        resizeFrame = requestAnimationFrame(() => {
          resizeFrame = null
          if (!disposed) fit(fitAddon)
        })
      })
      resizeObserver.observe(host)
      if ('fonts' in document) {
        void document.fonts
          .load('13px "JetBrains Mono"')
          .then(() => !disposed && fit(fitAddon))
          .catch(() => undefined)
      }
      await connect()
    }

    const handleOnline = () => reconnectNow()
    window.addEventListener('online', handleOnline)
    void start().catch((cause) => {
      if (disposed || controller.signal.aborted) return
      const message = terminalPlainText(cause instanceof Error ? cause.message : '') || 'Terminal could not start'
      updateConnection({ phase: 'error', message, action: 'new' })
    })

    return () => {
      disposed = true
      reconnectNowRef.current = () => undefined
      controller.abort()
      window.removeEventListener('online', handleOnline)
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
      stopHeartbeat()
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame)
      if (persistFrame !== null) cancelAnimationFrame(persistFrame)
      resizeObserver?.disconnect()
      socket?.close(1_000, 'Terminal window closed')
      for (const disposable of disposables) disposable.dispose()
      searchAddonRef.current = null
      const terminal = terminalRef.current
      terminalRef.current = null
      safelyDisposeTerminal(terminal)
      const current = session
      if (current && !terminalEnded) {
        recordPendingCleanup(current.id)
        storeSession(current, true)
        void terminateAndClear(current, true).catch(() => undefined)
      }
    }
  }, [agentId, cleanupStorageKey, run, storageKey])

  function find(direction: 'next' | 'previous') {
    const value = searchValue.trim()
    if (!value) return
    if (direction === 'next') searchAddonRef.current?.findNext(value)
    else searchAddonRef.current?.findPrevious(value)
  }

  const busy = ['connecting', 'initializing', 'reconnecting'].includes(connection.phase)
  return (
    <div className="relative h-full bg-[#0a0c10] p-2" data-shortcuts="native">
      <div
        ref={hostRef}
        className="h-full w-full outline-none [&_.xterm]:h-full [&_.xterm]:p-[0.3rem] [&_.xterm-viewport]:[scrollbar-color:rgb(255_255_255/0.2)_transparent]"
        aria-label="Interactive Tengri terminal"
        data-renderer={renderer}
        role="application"
        tabIndex={0}
      />

      <div
        className="absolute top-2 right-3 flex max-w-[min(70%,28rem)] items-center gap-1.5 rounded-full border border-white/7 bg-black/55 px-2 py-1 text-[10px] text-white/58 shadow-lg backdrop-blur-md"
        role="status"
        aria-live="polite"
      >
        {busy ? <LoaderCircle className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
        {renderer === 'dom' ? (
          <AlertTriangle className="h-3 w-3 shrink-0 text-amber-300" aria-label="Canvas unavailable" />
        ) : null}
        <span className="truncate">{connection.message}</span>
        {connection.action ? (
          <button
            type="button"
            className="ml-1 inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[#86b9ff] hover:bg-white/8"
            onClick={() => {
              if (connection.action === 'new') setRun((value) => value + 1)
              else reconnectNowRef.current()
            }}
          >
            <RotateCw className="h-2.5 w-2.5" aria-hidden="true" />
            {connection.action === 'new' ? 'New' : 'Retry'}
          </button>
        ) : null}
      </div>

      {searchOpen ? (
        <form
          role="search"
          aria-label="Search terminal output"
          className="absolute top-10 right-3 flex items-center gap-1 rounded-xl border border-white/12 bg-[#1a1d24]/96 p-1.5 text-white shadow-2xl backdrop-blur-xl"
          onSubmit={(event) => {
            event.preventDefault()
            find('next')
          }}
        >
          <Search className="ml-1 h-3.5 w-3.5 text-white/35" aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="search"
            value={searchValue}
            placeholder="Find"
            aria-label="Search text"
            className="w-44 bg-transparent px-1 py-1 text-xs text-white/85 outline-none placeholder:text-white/28"
            onChange={(event) => {
              const value = event.target.value
              setSearchValue(value)
              if (value) searchAddonRef.current?.findNext(value, { incremental: true })
              else searchAddonRef.current?.clearDecorations()
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setSearchOpen(false)
                terminalRef.current?.focus()
              }
            }}
          />
          <button
            type="button"
            aria-label="Previous match"
            className="rounded p-1 hover:bg-white/8"
            onClick={() => find('previous')}
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button type="submit" aria-label="Next match" className="rounded p-1 hover:bg-white/8">
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="Close search"
            className="rounded p-1 hover:bg-white/8"
            onClick={() => {
              setSearchOpen(false)
              terminalRef.current?.focus()
            }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </form>
      ) : null}
    </div>
  )
}
