'use client'

import { FileSearch, Monitor, Play, Search } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { TengriFileEntry } from '@/lib/tengri/types'
import { APP_TITLES, type TengriApp } from '@/lib/tengri/window-manager'
import { runTengriAction } from './client'
import { DOCK_APPS } from './desktop-apps'
import { useModalFocus } from './modal-focus'

type SpotlightResult =
  | { id: string; kind: 'app'; label: string; detail: string; app: TengriApp }
  | { id: string; kind: 'file'; label: string; detail: string; path: string }
  | { id: string; kind: 'action'; label: string; detail: string; run: () => void }

export function Spotlight({
  agentId,
  onClose,
  onOpenApp,
  onOpenFile,
}: {
  agentId: string
  onClose: () => void
  onOpenApp: (app: TengriApp) => void
  onOpenFile: (path: string) => void
}) {
  const modalFocus = useModalFocus<HTMLElement>()
  const reducedMotion = useReducedMotion()
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<TengriFileEntry[]>([])
  const [recentIds, setRecentIds] = useState<string[]>([])
  const [searchError, setSearchError] = useState('')
  const [searching, setSearching] = useState(false)
  const [selection, setSelection] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const recentKey = `tengri:spotlight:${agentId}:recents`

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(recentKey) || '[]') as unknown
      setRecentIds(
        Array.isArray(stored)
          ? stored.filter((value): value is string => typeof value === 'string' && value.length <= 4_200).slice(0, 8)
          : [],
      )
    } catch {
      setRecentIds([])
    }
  }, [recentKey])

  useEffect(() => {
    if (query.trim().length < 2) {
      setFiles([])
      setSearchError('')
      setSearching(false)
      return
    }
    setSearching(true)
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void runTengriAction<TengriFileEntry[]>({ action: 'search-files', agentId, path: '/', query }, controller.signal)
        .then((entries) => {
          setFiles(entries.slice(0, 8))
          setSearchError('')
          setSearching(false)
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return
          setFiles([])
          setSearchError(cause instanceof Error ? cause.message : 'File search is unavailable')
          setSearching(false)
        })
    }, 180)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [agentId, query])

  const results = useMemo<SpotlightResult[]>(() => {
    const needle = query.trim().toLowerCase()
    const apps = DOCK_APPS.filter((app) => fuzzy(APP_TITLES[app].toLowerCase(), needle)).map((app) => ({
      id: `app:${app}`,
      kind: 'app' as const,
      label: APP_TITLES[app],
      detail: 'Application',
      app,
    }))
    const actions = [
      {
        id: 'action:settings',
        kind: 'action' as const,
        label: 'Open Agent Settings',
        detail: 'Desktop action',
        run: () => onOpenApp('settings'),
      },
      {
        id: 'action:terminal',
        kind: 'action' as const,
        label: 'New Terminal',
        detail: 'Desktop action',
        run: () => onOpenApp('terminal'),
      },
    ].filter((item) => fuzzy(item.label.toLowerCase(), needle))
    const fileResults = files.map((file) => ({
      id: `file:${file.path}`,
      kind: 'file' as const,
      label: file.name,
      detail: file.path,
      path: file.path,
    }))
    const recentPosition = new Map(recentIds.map((id, index) => [id, index]))
    return [...apps, ...actions, ...fileResults]
      .sort((left, right) => (recentPosition.get(left.id) ?? 99) - (recentPosition.get(right.id) ?? 99))
      .slice(0, 12)
  }, [files, onOpenApp, query, recentIds])

  useEffect(() => setSelection(0), [query])
  useEffect(() => setSelection((index) => Math.min(index, Math.max(0, results.length - 1))), [results.length])

  function activate(result: SpotlightResult | undefined) {
    if (!result) return
    const nextRecentIds = [result.id, ...recentIds.filter((id) => id !== result.id)].slice(0, 8)
    try {
      localStorage.setItem(recentKey, JSON.stringify(nextRecentIds))
    } catch {
      // Spotlight recents are optional; launching the selected result must still succeed.
    }
    if (result.kind === 'app') onOpenApp(result.app)
    else if (result.kind === 'file') onOpenFile(result.path)
    else result.run()
    onClose()
  }

  return (
    <motion.div
      animate={{ opacity: 1 }}
      className="fixed inset-0 z-[4000] bg-black/10 pt-[14vh]"
      exit={{ opacity: 0 }}
      initial={reducedMotion ? false : { opacity: 0 }}
      onPointerDown={(event) => event.target === event.currentTarget && onClose()}
      role="presentation"
    >
      <motion.section
        ref={modalFocus.ref}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        aria-label="Spotlight"
        aria-modal="true"
        data-tengri-modal="true"
        className="mx-auto w-[min(680px,calc(100vw-32px))] overflow-hidden rounded-[22px] border border-white/20 bg-[rgba(31,35,48,0.86)] shadow-[0_35px_120px_rgba(0,0,0,0.55)] backdrop-blur-3xl"
        exit={reducedMotion ? undefined : { opacity: 0, scale: 0.97, y: -12 }}
        initial={reducedMotion ? false : { opacity: 0, scale: 0.96, y: -18 }}
        onKeyDown={modalFocus.onKeyDown}
        role="dialog"
        tabIndex={-1}
      >
        <label className="flex h-16 items-center gap-3 border-b border-white/10 px-5">
          <Search aria-hidden="true" className="h-6 w-6 text-white/45" />
          <input
            ref={inputRef}
            aria-activedescendant={results[selection] ? `spotlight-result-${selection}` : undefined}
            aria-autocomplete="list"
            aria-controls="spotlight-results"
            aria-expanded="true"
            aria-label="Spotlight search"
            className="min-w-0 flex-1 bg-transparent text-xl font-light text-white/90 outline-none placeholder:text-white/30"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                if (results.length) setSelection((index) => Math.min(results.length - 1, index + 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setSelection((index) => Math.max(0, index - 1))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                activate(results[selection])
              } else if (event.key === 'Escape') {
                event.preventDefault()
                onClose()
              }
            }}
            placeholder="Search apps, actions, and files"
            role="combobox"
            value={query}
          />
          <kbd className="rounded-md border border-white/12 bg-white/6 px-2 py-1 text-[10px] text-white/38">esc</kbd>
        </label>
        {searchError ? (
          <p className="border-b border-red-300/10 bg-red-500/8 px-5 py-2 text-xs text-red-200" role="alert">
            {searchError}
          </p>
        ) : null}
        <div
          aria-label="Search results"
          className="max-h-[430px] overflow-auto p-2"
          id="spotlight-results"
          role="listbox"
        >
          {searching && !results.length ? (
            <p className="px-4 py-8 text-center text-sm text-white/38" role="status">
              Searching…
            </p>
          ) : results.length ? (
            results.map((result, index) => (
              <button
                aria-selected={index === selection}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left outline-none ${index === selection ? 'bg-[#2574e8] text-white' : 'text-white/76'}`}
                id={`spotlight-result-${index}`}
                key={result.id}
                onClick={() => activate(result)}
                onMouseEnter={() => setSelection(index)}
                role="option"
                type="button"
              >
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-white/10">
                  {result.kind === 'app' ? (
                    <Monitor aria-hidden="true" className="h-4 w-4" />
                  ) : result.kind === 'file' ? (
                    <FileSearch aria-hidden="true" className="h-4 w-4" />
                  ) : (
                    <Play aria-hidden="true" className="h-4 w-4" />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{result.label}</span>
                  <span className="block truncate text-[11px] text-white/45">{result.detail}</span>
                </span>
              </button>
            ))
          ) : (
            <p className="px-4 py-8 text-center text-sm text-white/38">No matches</p>
          )}
        </div>
      </motion.section>
    </motion.div>
  )
}

export function fuzzy(value: string, query: string) {
  if (!query) return true
  let index = 0
  for (const character of value) if (character === query[index]) index += 1
  return index === query.length
}
