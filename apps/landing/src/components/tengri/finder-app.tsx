'use client'

import {
  ArrowLeft,
  ArrowRight,
  File,
  FileCode2,
  Folder,
  Grid2X2,
  House,
  List,
  LoaderCircle,
  Search,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { TengriFileEntry } from '@/lib/tengri/types'

import { runTengriAction } from './client'
import {
  FINDER_HOME_PATH,
  FINDER_WORKSPACE_PATH,
  finderFileKind,
  formatFinderBytes,
  formatFinderDate,
  normalizeFinderPath,
} from './finder-model'

type FinderView = 'grid' | 'list'

const toolbarButtonClass =
  'grid h-7 w-7 shrink-0 place-items-center rounded-lg text-white/60 transition-colors hover:bg-white/8 hover:text-white disabled:pointer-events-none disabled:opacity-25'

export function FinderApp({ agentId, onOpenFile }: { agentId: string; onOpenFile: (path: string) => void }) {
  const [path, setPath] = useState(FINDER_WORKSPACE_PATH)
  const [pathDraft, setPathDraft] = useState(FINDER_WORKSPACE_PATH)
  const [history, setHistory] = useState<string[]>([FINDER_WORKSPACE_PATH])
  const [historyIndex, setHistoryIndex] = useState(0)
  const [entries, setEntries] = useState<TengriFileEntry[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [view, setView] = useState<FinderView>('list')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [watchState, setWatchState] = useState<'connected' | 'reconnecting'>('reconnecting')
  const [error, setError] = useState('')
  const loadSequence = useRef(0)
  const latestLoad = useRef<(quiet?: boolean) => Promise<void>>(async () => {})

  const selectedEntry = entries.find((entry) => entry.path === selectedPath) ?? null

  const load = useCallback(
    async (quiet = false, signal?: AbortSignal) => {
      const sequence = ++loadSequence.current
      if (!quiet) setLoading(true)
      setError('')
      try {
        const result = query.trim()
          ? {
              entries: await runTengriAction<TengriFileEntry[]>(
                { action: 'search-files', agentId, path, query },
                signal,
              ),
            }
          : await runTengriAction<{ path: string; entries: TengriFileEntry[] }>(
              { action: 'list-files', agentId, path },
              signal,
            )
        if (sequence !== loadSequence.current || signal?.aborted) return
        setEntries(result.entries)
        setSelectedPath((current) => (result.entries.some((entry) => entry.path === current) ? current : null))
      } catch (cause) {
        if (sequence !== loadSequence.current || signal?.aborted) return
        setError(cause instanceof Error ? cause.message : 'Finder could not load this folder')
      } finally {
        if (sequence === loadSequence.current && !signal?.aborted) setLoading(false)
      }
    },
    [agentId, path, query],
  )
  latestLoad.current = (quiet = false) => load(quiet)

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => void load(false, controller.signal), query ? 180 : 0)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [load, query])

  useEffect(() => {
    let refreshTimer = 0
    const source = new EventSource(
      `/api/tengri/files/events?agentId=${encodeURIComponent(agentId)}&path=${encodeURIComponent(path)}`,
    )
    source.onopen = () => setWatchState('connected')
    source.onerror = () => setWatchState('reconnecting')
    source.onmessage = () => {
      window.clearTimeout(refreshTimer)
      refreshTimer = window.setTimeout(() => void latestLoad.current(true), 120)
    }
    return () => {
      window.clearTimeout(refreshTimer)
      source.close()
    }
  }, [agentId, path])

  const navigate = useCallback(
    (nextPath: string) => {
      const normalized = normalizeFinderPath(nextPath)
      if (!normalized) {
        setError('Enter an absolute path inside Home')
        return
      }
      setPathDraft(normalized)
      setQuery('')
      setSelectedPath(null)
      setError('')
      if (normalized === path) {
        void latestLoad.current(false)
        return
      }
      setPath(normalized)
      setHistory((current) => [...current.slice(0, historyIndex + 1), normalized])
      setHistoryIndex((index) => index + 1)
    },
    [historyIndex, path],
  )

  const navigateHistory = useCallback(
    (index: number) => {
      const nextPath = history[index]
      if (!nextPath) return
      setHistoryIndex(index)
      setPath(nextPath)
      setPathDraft(nextPath)
      setQuery('')
      setSelectedPath(null)
      setError('')
    },
    [history],
  )

  const activate = useCallback(
    (entry: TengriFileEntry) => {
      if (entry.directory) navigate(entry.path)
      else onOpenFile(entry.path)
    },
    [navigate, onOpenFile],
  )

  return (
    <div className="relative flex h-full min-h-0 bg-[#17191f] text-white/85">
      <aside className="w-44 shrink-0 border-r border-white/8 bg-white/[0.025] p-3 text-[12px]">
        <p className="mb-2 px-2 text-[10px] font-semibold tracking-wider text-white/58 uppercase">Favorites</p>
        {[
          { label: 'Home', path: FINDER_HOME_PATH, icon: House },
          { label: 'Workspace', path: FINDER_WORKSPACE_PATH, icon: Folder },
        ].map((item) => (
          <button
            type="button"
            key={item.label}
            onClick={() => navigate(item.path)}
            className={`mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${path === item.path ? 'bg-[#2574e8]/35 text-white' : 'text-white/65 hover:bg-white/7'}`}
          >
            <item.icon className="h-4 w-4 text-[#79b8ff]" />
            {item.label}
          </button>
        ))}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-white/8 px-3">
          <button
            type="button"
            aria-label="Back"
            disabled={historyIndex === 0}
            onClick={() => navigateHistory(historyIndex - 1)}
            className={toolbarButtonClass}
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="Forward"
            disabled={historyIndex >= history.length - 1}
            onClick={() => navigateHistory(historyIndex + 1)}
            className={toolbarButtonClass}
          >
            <ArrowRight className="h-4 w-4" />
          </button>
          <label className="ml-1 flex min-w-40 flex-1 items-center rounded-lg border border-white/8 bg-black/20 px-2.5 py-1.5 text-xs">
            <span className="sr-only">Go to folder</span>
            <input
              value={pathDraft}
              onChange={(event) => setPathDraft(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && navigate(event.currentTarget.value)}
              onBlur={() => setPathDraft(path)}
              className="w-full bg-transparent text-white/70 outline-none"
            />
          </label>
          <button
            type="button"
            className={toolbarButtonClass}
            aria-label="Open selected file in Code"
            disabled={!selectedEntry || selectedEntry.directory}
            onClick={() => selectedEntry && onOpenFile(selectedEntry.path)}
          >
            <FileCode2 className="h-4 w-4" />
          </button>
          <div className="flex rounded-lg border border-white/8 bg-black/20 p-0.5">
            <button
              type="button"
              className={`rounded-md p-1.5 ${view === 'list' ? 'bg-white/12' : ''}`}
              aria-label="List view"
              aria-pressed={view === 'list'}
              onClick={() => setView('list')}
            >
              <List className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className={`rounded-md p-1.5 ${view === 'grid' ? 'bg-white/12' : ''}`}
              aria-label="Icon view"
              aria-pressed={view === 'grid'}
              onClick={() => setView('grid')}
            >
              <Grid2X2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <label className="flex w-44 items-center gap-2 rounded-lg bg-black/25 px-2.5 py-1.5 text-xs">
            <Search className="h-3.5 w-3.5 text-white/35" />
            <input
              value={query}
              aria-label="Search files"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-white/28"
            />
          </label>
        </div>

        <div className="relative min-h-0 flex-1 overflow-auto p-3">
          {loading ? (
            <div role="status" className="flex h-full items-center justify-center gap-2 text-sm text-white/45">
              <LoaderCircle className="h-4 w-4 animate-spin" />
              Loading files…
            </div>
          ) : null}
          {!loading && error ? (
            <div role="alert" className="m-4 rounded-xl border border-red-400/20 bg-red-500/8 p-4 text-sm text-red-200">
              {error}
            </div>
          ) : null}
          {!loading && !error && entries.length === 0 ? (
            <div className="grid h-full place-items-center text-center text-sm text-white/38">
              <div>
                <Folder className="mx-auto mb-3 h-10 w-10 text-white/18" />
                <p>{query ? 'No matching files' : 'This folder is empty'}</p>
              </div>
            </div>
          ) : null}
          {!loading && !error && entries.length > 0 && view === 'list' ? (
            <div
              role="group"
              aria-label="Files"
              className="min-w-[560px] overflow-hidden rounded-xl border border-white/7"
            >
              <div className="grid grid-cols-[minmax(220px,1fr)_100px_170px] bg-white/[0.035] px-3 py-2 text-[10px] font-semibold tracking-wide text-white/35 uppercase">
                <span>Name</span>
                <span>Size</span>
                <span>Modified</span>
              </div>
              {entries.map((entry) => (
                <FinderEntry
                  entry={entry}
                  key={entry.path}
                  selected={selectedPath === entry.path}
                  view="list"
                  onActivate={() => activate(entry)}
                  onSelect={() => setSelectedPath(entry.path)}
                />
              ))}
            </div>
          ) : null}
          {!loading && !error && entries.length > 0 && view === 'grid' ? (
            <div role="group" aria-label="Files" className="grid grid-cols-[repeat(auto-fill,minmax(108px,1fr))] gap-2">
              {entries.map((entry) => (
                <FinderEntry
                  entry={entry}
                  key={entry.path}
                  selected={selectedPath === entry.path}
                  view="grid"
                  onActivate={() => activate(entry)}
                  onSelect={() => setSelectedPath(entry.path)}
                />
              ))}
            </div>
          ) : null}
        </div>

        <div
          aria-live="polite"
          className="flex h-7 shrink-0 items-center justify-between border-t border-white/7 px-3 py-1 text-[10px] text-white/35"
        >
          <span>
            {entries.length} items{selectedEntry ? ' · 1 selected' : ''}
          </span>
          <span className={watchState === 'connected' ? 'text-emerald-300/60' : 'text-amber-200/65'}>
            {watchState === 'connected' ? 'Live' : 'Reconnecting…'}
          </span>
        </div>
      </div>
    </div>
  )
}

function FinderEntry({
  entry,
  onActivate,
  onSelect,
  selected,
  view,
}: {
  entry: TengriFileEntry
  onActivate: () => void
  onSelect: () => void
  selected: boolean
  view: FinderView
}) {
  if (view === 'grid') {
    return (
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        onDoubleClick={onActivate}
        onKeyDown={(event) => event.key === 'Enter' && onActivate()}
        className={`flex min-h-28 flex-col items-center justify-center gap-2 rounded-xl p-3 text-center text-xs ${selected ? 'bg-[#2574e8]/42' : 'hover:bg-white/6'}`}
      >
        <FinderFileIcon entry={entry} large />
        <span className="line-clamp-2 break-all">{entry.name}</span>
      </button>
    )
  }

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      onDoubleClick={onActivate}
      onKeyDown={(event) => event.key === 'Enter' && onActivate()}
      className={`grid w-full grid-cols-[minmax(220px,1fr)_100px_170px] items-center border-t border-white/6 px-3 py-2 text-left text-xs ${selected ? 'bg-[#2574e8]/42' : 'hover:bg-white/[0.045]'}`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <FinderFileIcon entry={entry} />
        <span className="truncate">{entry.name}</span>
      </span>
      <span className="text-white/42">{entry.directory ? '—' : formatFinderBytes(entry.size)}</span>
      <span className="text-white/42">{formatFinderDate(entry.modifiedAt)}</span>
    </button>
  )
}

function FinderFileIcon({ entry, large = false }: { entry: TengriFileEntry; large?: boolean }) {
  const className = large ? 'h-11 w-11' : 'h-4 w-4'
  switch (finderFileKind(entry)) {
    case 'folder':
      return <Folder className={`${className} fill-[#79b8ff]/25 text-[#79b8ff]`} />
    case 'code':
      return <FileCode2 className={`${className} text-[#9ccfd8]`} />
    default:
      return <File className={`${className} text-white/45`} />
  }
}
