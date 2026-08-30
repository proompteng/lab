'use client'

import {
  ArrowLeft,
  ArrowRight,
  Bot,
  ExternalLink,
  LoaderCircle,
  MonitorUp,
  Plus,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useReducer, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { TengriPreviewSession } from '@/lib/tengri/types'
import { AgentChat } from './agent-chat'
import {
  activeChromeTab,
  chromeTabLoadInstanceKey,
  chromeReducer,
  currentChromePage,
  initialChromeState,
  MAX_CHROME_TABS,
  parseChromeAddress,
  parsePreviewBridgeMessage,
  safePreviewLaunchUrl,
  safePreviewSessionOrigin,
  type ChromePage,
  type ChromePreviewNavigationMode,
  type ChromePreviewShortcut,
} from './chrome-model'
import { runTengriAction } from './client'

type PreviewPage = Extract<ChromePage, { kind: 'preview' }>

function chromeTabKeyTarget(key: string, currentIndex: number, tabCount: number) {
  if (tabCount < 1) return null
  if (key === 'Home') return 0
  if (key === 'End') return tabCount - 1
  if (key === 'ArrowLeft') return (currentIndex - 1 + tabCount) % tabCount
  if (key === 'ArrowRight') return (currentIndex + 1) % tabCount
  return null
}

function focusChromeTab(tabId: string) {
  window.requestAnimationFrame(() => {
    document.getElementById(`chrome-tab-${tabId}`)?.focus()
  })
}

export function ChromeApp({
  active: applicationActive = true,
  agentId,
  previewGatewayOrigin,
}: {
  active?: boolean
  agentId: string
  previewGatewayOrigin: string
}) {
  const [state, dispatch] = useReducer(chromeReducer, undefined, initialChromeState)
  const activeTab = activeChromeTab(state)
  const activePage = currentChromePage(activeTab)
  const [address, setAddress] = useState(activePage.displayUrl)
  const [navigationError, setNavigationError] = useState('')
  const addressRef = useRef<HTMLInputElement | null>(null)
  const externalPreviewSessionsRef = useRef(new Map<string, { popup: Window; sessionId: string }>())

  useEffect(() => {
    const sessions = externalPreviewSessionsRef.current
    const interval = window.setInterval(() => {
      for (const [sessionId, session] of sessions) {
        if (session.popup.closed) {
          sessions.delete(sessionId)
          void revokePreview(agentId, session.sessionId)
        }
      }
    }, 250)
    return () => {
      window.clearInterval(interval)
      for (const session of sessions.values()) void revokePreview(agentId, session.sessionId)
      sessions.clear()
    }
  }, [agentId])

  useEffect(() => {
    setAddress(activePage.displayUrl)
    setNavigationError('')
  }, [activePage.displayUrl, state.activeId])

  function navigate(raw: string) {
    const parsed = parseChromeAddress(raw)
    setNavigationError('')
    if (parsed.kind === 'invalid') {
      setNavigationError(parsed.message)
      return
    }
    if (parsed.kind === 'external') {
      window.open(parsed.url, '_blank', 'noopener,noreferrer')
      setAddress(activePage.displayUrl)
      return
    }
    dispatch({ type: 'navigate', page: parsed.page })
  }

  async function openExternally() {
    if (activePage.kind !== 'preview') return
    setNavigationError('')
    const popup = window.open('about:blank', '_blank')
    if (!popup) {
      setNavigationError('Allow pop-ups to open this preview in a browser tab.')
      return
    }
    popup.opener = null
    let issuedSessionId = ''
    try {
      const session = await issuePreview(agentId, activePage)
      issuedSessionId = session.id
      const launchUrl = safePreviewLaunchUrl(session.launchUrl, previewGatewayOrigin)
      if (!launchUrl) throw new Error('Tengri returned an invalid preview URL')
      popup.location.replace(launchUrl)
      // expiresAt is the one-use bootstrap ticket deadline, not the lifetime of the active preview.
      externalPreviewSessionsRef.current.set(session.id, { popup, sessionId: session.id })
    } catch (cause) {
      if (issuedSessionId) void revokePreview(agentId, issuedSessionId)
      popup.close()
      setNavigationError(cause instanceof Error ? cause.message : 'The microVM preview could not be opened')
    }
  }

  const runShortcut = useCallback(
    (key: ChromePreviewShortcut) => {
      if (key === 'l') {
        addressRef.current?.focus()
        addressRef.current?.select()
      } else if (key === 'r') {
        dispatch({ type: 'reload' })
      } else if (key === 't') {
        dispatch({ type: 'new-tab' })
      } else {
        dispatch({ type: 'close', id: state.activeId })
      }
    },
    [state.activeId],
  )

  function handleShortcut(event: KeyboardEvent<HTMLDivElement>) {
    if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return
    const key = event.key.toLowerCase() as ChromePreviewShortcut
    if (!['l', 'r', 't', 'w'].includes(key)) return
    event.preventDefault()
    event.stopPropagation()
    runShortcut(key)
  }

  const synchronizePreview = useCallback((id: string, page: PreviewPage, mode: ChromePreviewNavigationMode) => {
    dispatch({ type: 'frame-navigate', id, mode, page })
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#101216]" onKeyDownCapture={handleShortcut}>
      <div className="flex h-9 shrink-0 items-end gap-1 border-b border-white/8 bg-white/[0.025] px-2 pt-1">
        <div
          aria-label="Browser tabs"
          aria-orientation="horizontal"
          className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto"
          role="tablist"
        >
          {state.tabs.map((tab, index) => {
            const page = currentChromePage(tab)
            const selected = tab.id === state.activeId
            return (
              <button
                aria-controls={`chrome-panel-${tab.id}`}
                aria-keyshortcuts="Delete"
                aria-selected={selected}
                className={`flex h-8 max-w-52 min-w-32 shrink-0 items-center gap-2 rounded-t-lg px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-white/50 ${
                  selected ? 'bg-[#1b1e25] text-white/85' : 'text-white/55 hover:bg-white/5'
                }`}
                id={`chrome-tab-${tab.id}`}
                key={tab.id}
                onClick={(event) => {
                  if (event.target instanceof Element && event.target.closest('[data-close-chrome-tab]')) {
                    dispatch({ type: 'close', id: tab.id })
                    return
                  }
                  dispatch({ type: 'activate', id: tab.id })
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Delete') {
                    event.preventDefault()
                    const nextTabId =
                      state.tabs[index + 1]?.id ?? state.tabs[index - 1]?.id ?? `tab-${state.nextTabNumber}`
                    dispatch({ type: 'close', id: tab.id })
                    focusChromeTab(nextTabId)
                    return
                  }

                  const targetIndex = chromeTabKeyTarget(event.key, index, state.tabs.length)
                  if (targetIndex === null) return
                  event.preventDefault()
                  const targetTab = state.tabs[targetIndex]
                  if (!targetTab) return
                  dispatch({ type: 'activate', id: targetTab.id })
                  focusChromeTab(targetTab.id)
                }}
                role="tab"
                tabIndex={selected ? 0 : -1}
                type="button"
              >
                {page.kind === 'agent' ? (
                  <Bot className="h-3.5 w-3.5 shrink-0 text-[#9ccfd8]" aria-hidden="true" />
                ) : (
                  <MonitorUp className="h-3.5 w-3.5 shrink-0 text-[#79b8ff]" aria-hidden="true" />
                )}
                <span className="truncate">{page.title}</span>
                <span className="sr-only">. Press Delete to close.</span>
                <span
                  aria-hidden="true"
                  className="ml-auto rounded p-0.5 text-white/50 hover:bg-white/10 hover:text-white/80"
                  data-close-chrome-tab
                >
                  <X className="h-3 w-3" />
                </span>
              </button>
            )
          })}
        </div>
        <button
          type="button"
          aria-label="New tab"
          className="mb-1 rounded-md p-1 text-white/40 outline-none hover:bg-white/8 focus-visible:ring-2 focus-visible:ring-white/50 disabled:opacity-25"
          disabled={state.tabs.length >= MAX_CHROME_TABS}
          onClick={() => dispatch({ type: 'new-tab' })}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <form
        className="flex h-11 shrink-0 items-center gap-2 border-b border-white/8 bg-[#1b1e25] px-3"
        onSubmit={(event) => {
          event.preventDefault()
          navigate(address)
        }}
      >
        <ToolbarButton
          disabled={activeTab.historyIndex === 0}
          label="Back"
          onClick={() => dispatch({ type: 'history', offset: -1 })}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton
          disabled={activeTab.historyIndex >= activeTab.history.length - 1}
          label="Forward"
          onClick={() => dispatch({ type: 'history', offset: 1 })}
        >
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </ToolbarButton>
        {address === activePage.displayUrl ? (
          <ToolbarButton label="Reload" onClick={() => dispatch({ type: 'reload' })}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
          </ToolbarButton>
        ) : (
          <ToolbarButton label="Go" type="submit">
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </ToolbarButton>
        )}
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-white/8 bg-black/25 px-3 py-1.5 text-xs shadow-inner focus-within:border-white/16">
          <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
          <span className="sr-only">Private Tengri address</span>
          <input
            ref={addressRef}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-center text-white/66 outline-none focus:text-left"
            aria-label="Address"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <ToolbarButton
          disabled={activePage.kind !== 'preview'}
          label="Open current preview in browser"
          onClick={() => void openExternally()}
        >
          <ExternalLink className="h-4 w-4" aria-hidden="true" />
        </ToolbarButton>
      </form>
      {navigationError ? (
        <div role="alert" className="border-b border-red-400/15 bg-red-500/10 px-4 py-2 text-xs text-red-100">
          {navigationError}
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1 bg-[#0e1014]">
        {state.tabs.map((tab) => {
          const page = currentChromePage(tab)
          const selected = tab.id === state.activeId
          return (
            <div
              aria-labelledby={`chrome-tab-${tab.id}`}
              className="absolute inset-0"
              hidden={!selected}
              id={`chrome-panel-${tab.id}`}
              key={tab.id}
              role="tabpanel"
            >
              {page.kind === 'agent' ? (
                <AgentChat
                  active={applicationActive && selected}
                  agentId={agentId}
                  key={chromeTabLoadInstanceKey(tab)}
                />
              ) : (
                <PreviewFrame
                  active={applicationActive && selected}
                  agentId={agentId}
                  key={tab.id}
                  loadRevision={tab.load.revision}
                  onNavigate={(nextPage, mode) => synchronizePreview(tab.id, nextPage, mode)}
                  onShortcut={runShortcut}
                  page={page}
                  previewGatewayOrigin={previewGatewayOrigin}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PreviewFrame({
  active,
  agentId,
  loadRevision,
  onNavigate,
  onShortcut,
  page,
  previewGatewayOrigin,
}: {
  active: boolean
  agentId: string
  loadRevision: number
  onNavigate: (page: PreviewPage, mode: ChromePreviewNavigationMode) => void
  onShortcut: (key: ChromePreviewShortcut) => void
  page: PreviewPage
  previewGatewayOrigin: string
}) {
  const [attempt, setAttempt] = useState(0)
  const [session, setSession] = useState<{ id: string; launchUrl: string; previewOrigin: string } | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const pageRef = useRef(page)
  pageRef.current = page

  useEffect(() => {
    if (!active) return
    let disposed = false
    let issuedSessionId = ''
    setSession(null)
    setLoaded(false)
    setError('')
    void issuePreview(agentId, pageRef.current)
      .then((issued) => {
        issuedSessionId = issued.id
        if (disposed) {
          void revokePreview(agentId, issued.id)
          return
        }
        const safeUrl = safePreviewLaunchUrl(issued.launchUrl, previewGatewayOrigin)
        if (!safeUrl) throw new Error('Tengri returned an invalid preview URL')
        const previewOrigin = safePreviewSessionOrigin(issued.previewOrigin, issued.id)
        if (!previewOrigin) throw new Error('Tengri returned an invalid preview origin')
        setSession({ id: issued.id, launchUrl: safeUrl, previewOrigin })
      })
      .catch((cause: unknown) => {
        if (!disposed) {
          setError(cause instanceof Error ? cause.message : 'The microVM preview could not be opened')
        }
      })
    return () => {
      disposed = true
      if (issuedSessionId) void revokePreview(agentId, issuedSessionId)
    }
  }, [active, agentId, attempt, loadRevision, previewGatewayOrigin])

  useEffect(() => {
    if (!session) return
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== iframeRef.current?.contentWindow) return
      const message = parsePreviewBridgeMessage(event.data, event.origin, session.previewOrigin, session.id, page.port)
      if (!message) return
      if (message.kind === 'shortcut') onShortcut(message.key)
      else onNavigate(message.page, message.mode)
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [onNavigate, onShortcut, page.port, session])

  if (error) {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div>
          <p className="text-sm text-red-200" role="alert">
            {error}
          </p>
          <button
            type="button"
            className="mt-4 rounded-xl bg-white/9 px-4 py-2 text-xs text-white/76 outline-none hover:bg-white/13 focus-visible:ring-2 focus-visible:ring-white/50"
            onClick={() => setAttempt((current) => current + 1)}
          >
            Retry preview
          </button>
        </div>
      </div>
    )
  }
  if (!session) {
    return (
      <div role="status" className="flex h-full items-center justify-center gap-2 text-sm text-white/48">
        <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> Opening localhost preview…
      </div>
    )
  }
  return (
    <div className="relative h-full w-full bg-white">
      {!loaded ? (
        <div
          role="status"
          className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-[#0e1014] text-sm text-white/48"
        >
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> Connecting to localhost…
        </div>
      ) : null}
      <iframe
        ref={iframeRef}
        title={page.title}
        src={session.launchUrl}
        className="h-full w-full border-0 bg-white"
        onLoad={() => setLoaded(true)}
        referrerPolicy="no-referrer"
        sandbox="allow-downloads allow-forms allow-modals allow-pointer-lock allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
      />
    </div>
  )
}

function ToolbarButton({
  children,
  disabled = false,
  label,
  onClick,
  type = 'button',
}: {
  children: ReactNode
  disabled?: boolean
  label: string
  onClick?: () => void
  type?: 'button' | 'submit'
}) {
  return (
    <button
      type={type}
      aria-label={label}
      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-white/48 outline-none hover:bg-white/8 hover:text-white/76 focus-visible:ring-2 focus-visible:ring-white/50 disabled:opacity-22"
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function issuePreview(agentId: string, page: PreviewPage, signal?: AbortSignal) {
  return runTengriAction<TengriPreviewSession>(
    {
      action: 'preview-session',
      agentId,
      port: page.port,
      path: page.path,
    },
    signal,
  )
}

function revokePreview(agentId: string, sessionId: string) {
  return runTengriAction<null>({ action: 'revoke-preview-session', agentId, sessionId }).catch(() => null)
}
