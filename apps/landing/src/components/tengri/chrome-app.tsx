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
import { useEffect, useReducer, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { TengriPreviewSession } from '@/lib/tengri/types'
import { AgentChat } from './agent-chat'
import {
  activeChromeTab,
  chromeReducer,
  currentChromePage,
  initialChromeState,
  MAX_CHROME_TABS,
  parseChromeAddress,
  safePreviewLaunchUrl,
  type ChromePage,
} from './chrome-model'
import { runTengriAction } from './client'

type PreviewPage = Extract<ChromePage, { kind: 'preview' }>

export function ChromeApp({ agentId }: { agentId: string }) {
  const [state, dispatch] = useReducer(chromeReducer, undefined, initialChromeState)
  const active = activeChromeTab(state)
  const activePage = currentChromePage(active)
  const [address, setAddress] = useState(activePage.displayUrl)
  const [navigationError, setNavigationError] = useState('')
  const addressRef = useRef<HTMLInputElement | null>(null)

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
    try {
      const session = await issuePreview(agentId, activePage)
      const launchUrl = safePreviewLaunchUrl(session.launchUrl)
      if (!launchUrl) throw new Error('Tengri returned an invalid preview URL')
      popup.location.replace(launchUrl)
    } catch (cause) {
      popup.close()
      setNavigationError(cause instanceof Error ? cause.message : 'The microVM preview could not be opened')
    }
  }

  function handleShortcut(event: KeyboardEvent<HTMLDivElement>) {
    if (!event.metaKey) return
    const key = event.key.toLowerCase()
    if (!['l', 'r', 't', 'w'].includes(key)) return
    event.preventDefault()
    event.stopPropagation()
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
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#101216]" onKeyDownCapture={handleShortcut}>
      <div
        aria-label="Browser tabs"
        className="flex h-9 shrink-0 items-end gap-1 overflow-x-auto border-b border-white/8 bg-white/[0.025] px-2 pt-1"
        role="tablist"
      >
        {state.tabs.map((tab) => {
          const page = currentChromePage(tab)
          const selected = tab.id === state.activeId
          return (
            <div
              key={tab.id}
              className={`flex h-8 max-w-52 min-w-32 shrink-0 items-center gap-2 rounded-t-lg px-3 text-xs ${
                selected ? 'bg-[#1b1e25] text-white/85' : 'text-white/42 hover:bg-white/5'
              }`}
            >
              <button
                aria-controls={`chrome-panel-${tab.id}`}
                aria-selected={selected}
                className="flex min-w-0 flex-1 items-center gap-2 outline-none focus-visible:ring-2 focus-visible:ring-white/50"
                id={`chrome-tab-${tab.id}`}
                onClick={() => dispatch({ type: 'activate', id: tab.id })}
                role="tab"
                type="button"
              >
                {page.kind === 'agent' ? (
                  <Bot className="h-3.5 w-3.5 shrink-0 text-[#9ccfd8]" aria-hidden="true" />
                ) : (
                  <MonitorUp className="h-3.5 w-3.5 shrink-0 text-[#79b8ff]" aria-hidden="true" />
                )}
                <span className="truncate">{page.title}</span>
              </button>
              <button
                type="button"
                aria-label={`Close ${page.title} tab`}
                className="rounded p-0.5 text-white/36 outline-none hover:bg-white/10 hover:text-white/70 focus-visible:ring-2 focus-visible:ring-white/50"
                onClick={() => dispatch({ type: 'close', id: tab.id })}
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>
          )
        })}
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
          disabled={active.historyIndex === 0}
          label="Back"
          onClick={() => dispatch({ type: 'history', offset: -1 })}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton
          disabled={active.historyIndex >= active.history.length - 1}
          label="Forward"
          onClick={() => dispatch({ type: 'history', offset: 1 })}
        >
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton label="Reload" onClick={() => dispatch({ type: 'reload' })}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
        </ToolbarButton>
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
                <AgentChat agentId={agentId} key={`${tab.id}-${tab.historyIndex}-${tab.reload}`} />
              ) : (
                <PreviewFrame
                  active={selected}
                  agentId={agentId}
                  key={`${tab.id}-${tab.historyIndex}-${tab.reload}`}
                  page={page}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PreviewFrame({ active, agentId, page }: { active: boolean; agentId: string; page: PreviewPage }) {
  const [attempt, setAttempt] = useState(0)
  const [launchUrl, setLaunchUrl] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!active || launchUrl) return
    const controller = new AbortController()
    setLaunchUrl('')
    setLoaded(false)
    setError('')
    void issuePreview(agentId, page, controller.signal)
      .then((session) => {
        if (controller.signal.aborted) return
        const safeUrl = safePreviewLaunchUrl(session.launchUrl)
        if (!safeUrl) throw new Error('Tengri returned an invalid preview URL')
        setLaunchUrl(safeUrl)
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : 'The microVM preview could not be opened')
        }
      })
    return () => controller.abort()
  }, [active, agentId, attempt, launchUrl, page])

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
  if (!launchUrl) {
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
        title={page.title}
        src={launchUrl}
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
}: {
  children: ReactNode
  disabled?: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
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
