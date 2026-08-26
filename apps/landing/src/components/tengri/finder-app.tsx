'use client'

import * as Dialog from '@radix-ui/react-dialog'
import {
  ArrowLeft,
  ArrowRight,
  Eye,
  File,
  FileCode2,
  Folder,
  Grid2X2,
  House,
  List,
  LoaderCircle,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'

import type { TengriFileEntry } from '@/lib/tengri/types'

import { runTengriAction } from './client'
import { ConfirmationDialog } from './confirmation-dialog'
import {
  FINDER_HOME_PATH,
  FINDER_WORKSPACE_PATH,
  finderChildPath,
  finderFileKind,
  finderRenamePath,
  formatFinderBytes,
  formatFinderDate,
  normalizeFinderPath,
  updateFinderSelection,
} from './finder-model'

type FinderView = 'grid' | 'list'
type QuickLookState = {
  entry: TengriFileEntry
  content: string
  error: string
  loading: boolean
}

const toolbarButtonClass =
  'grid h-7 w-7 shrink-0 place-items-center rounded-lg text-white/60 transition-colors hover:bg-white/8 hover:text-white disabled:pointer-events-none disabled:opacity-25'

export function FinderApp({ agentId, onOpenFile }: { agentId: string; onOpenFile: (path: string) => void }) {
  const [path, setPath] = useState(FINDER_WORKSPACE_PATH)
  const [pathDraft, setPathDraft] = useState(FINDER_WORKSPACE_PATH)
  const [history, setHistory] = useState<string[]>([FINDER_WORKSPACE_PATH])
  const [historyIndex, setHistoryIndex] = useState(0)
  const [entries, setEntries] = useState<TengriFileEntry[]>([])
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [view, setView] = useState<FinderView>('list')
  const [query, setQuery] = useState('')
  const [newFolder, setNewFolder] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [renaming, setRenaming] = useState<TengriFileEntry | null>(null)
  const [quickLook, setQuickLook] = useState<QuickLookState | null>(null)
  const [selectionBox, setSelectionBox] = useState<{ left: number; top: number; width: number; height: number } | null>(
    null,
  )
  const [loading, setLoading] = useState(true)
  const [watchState, setWatchState] = useState<'connected' | 'reconnecting'>('reconnecting')
  const [error, setError] = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const entryRefs = useRef(new Map<string, HTMLElement>())
  const loadSequence = useRef(0)
  const latestLoad = useRef<(quiet?: boolean) => Promise<void>>(async () => {})
  const quickLookAbort = useRef<AbortController | null>(null)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    additive: Set<string>
    frame: number
  } | null>(null)

  const selectedEntries = entries.filter((entry) => selected.has(entry.path))
  const primarySelection = selectedEntries.length === 1 ? selectedEntries[0] : null

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
        setSelected(
          (current) =>
            new Set([...current].filter((entryPath) => result.entries.some((entry) => entry.path === entryPath))),
        )
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

  useEffect(
    () => () => {
      quickLookAbort.current?.abort()
      if (dragRef.current) window.cancelAnimationFrame(dragRef.current.frame)
    },
    [],
  )

  const navigate = useCallback(
    (nextPath: string) => {
      const normalized = normalizeFinderPath(nextPath)
      if (!normalized) {
        setError('Enter an absolute path inside Home')
        return
      }
      setPathDraft(normalized)
      setQuery('')
      setSelected(new Set())
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
      setSelected(new Set())
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

  async function createFolder() {
    const destination = finderChildPath(path, newFolder)
    if (!destination) {
      setError('Folder names cannot be empty or contain “/”')
      return
    }
    setActionBusy(true)
    setError('')
    try {
      await runTengriAction({ action: 'create-directory', agentId, path: destination })
      setNewFolder('')
      setShowCreate(false)
      await latestLoad.current(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Finder could not create this folder')
    } finally {
      setActionBusy(false)
    }
  }

  async function deleteSelected() {
    if (!selectedEntries.length) return
    setActionBusy(true)
    setError('')
    try {
      for (const entry of selectedEntries) {
        await runTengriAction({ action: 'delete-file', agentId, path: entry.path, recursive: entry.directory })
      }
      setSelected(new Set())
      setDeleteConfirmationOpen(false)
      await latestLoad.current(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Finder could not delete the selected items')
    } finally {
      setActionBusy(false)
    }
  }

  function beginRename() {
    if (!primarySelection) return
    setRenaming(primarySelection)
    setRenameValue(primarySelection.name)
  }

  async function renameSelected() {
    if (!renaming) return
    const destinationPath = finderRenamePath(renaming.path, renameValue)
    if (!destinationPath) {
      setError('Names cannot be empty or contain “/”')
      return
    }
    if (destinationPath === renaming.path) {
      setRenaming(null)
      return
    }
    setActionBusy(true)
    setError('')
    try {
      await runTengriAction({ action: 'move-file', agentId, sourcePath: renaming.path, destinationPath })
      setSelected(new Set([destinationPath]))
      setRenaming(null)
      await latestLoad.current(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Finder could not rename this item')
    } finally {
      setActionBusy(false)
    }
  }

  function closeQuickLook() {
    quickLookAbort.current?.abort()
    quickLookAbort.current = null
    setQuickLook(null)
  }

  async function openQuickLook(entry = primarySelection) {
    if (!entry) return
    quickLookAbort.current?.abort()
    if (entry.directory) {
      setQuickLook({ entry, content: '', error: '', loading: false })
      return
    }
    const controller = new AbortController()
    quickLookAbort.current = controller
    setQuickLook({ entry, content: '', error: '', loading: true })
    try {
      const result = await runTengriAction<{ content: string }>(
        { action: 'read-file', agentId, path: entry.path },
        controller.signal,
      )
      if (!controller.signal.aborted) setQuickLook({ entry, content: result.content, error: '', loading: false })
    } catch (cause) {
      if (controller.signal.aborted) return
      setQuickLook({
        entry,
        content: '',
        error: cause instanceof Error ? cause.message : 'Quick Look could not read this file',
        loading: false,
      })
    }
  }

  function selectEntry(entry: TengriFileEntry, event: ReactMouseEvent) {
    setSelected((current) =>
      updateFinderSelection(current, entries, entry.path, {
        additive: event.metaKey || event.ctrlKey,
        range: event.shiftKey,
      }),
    )
  }

  function beginDragSelection(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest('[data-file-entry], button, input')) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const additive = event.metaKey || event.ctrlKey ? new Set(selected) : new Set<string>()
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      additive,
      frame: 0,
    }
    if (!additive.size) setSelected(new Set())
  }

  function updateDragSelection(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    const host = contentRef.current
    if (!drag || !host || drag.pointerId !== event.pointerId) return
    window.cancelAnimationFrame(drag.frame)
    const clientX = event.clientX
    const clientY = event.clientY
    drag.frame = window.requestAnimationFrame(() => {
      const hostRect = host.getBoundingClientRect()
      const leftClient = Math.min(drag.startX, clientX)
      const topClient = Math.min(drag.startY, clientY)
      const rightClient = Math.max(drag.startX, clientX)
      const bottomClient = Math.max(drag.startY, clientY)
      setSelectionBox({
        left: leftClient - hostRect.left + host.scrollLeft,
        top: topClient - hostRect.top + host.scrollTop,
        width: rightClient - leftClient,
        height: bottomClient - topClient,
      })
      const next = new Set(drag.additive)
      for (const [entryPath, element] of entryRefs.current) {
        const bounds = element.getBoundingClientRect()
        if (
          bounds.right >= leftClient &&
          bounds.left <= rightClient &&
          bounds.bottom >= topClient &&
          bounds.top <= bottomClient
        )
          next.add(entryPath)
      }
      setSelected(next)
    })
  }

  function finishDragSelection(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    window.cancelAnimationFrame(drag.frame)
    dragRef.current = null
    setSelectionBox(null)
  }

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
            aria-label="New folder"
            disabled={actionBusy}
            onClick={() => setShowCreate(true)}
          >
            <Plus className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={toolbarButtonClass}
            aria-label="Delete selected item"
            disabled={!selected.size || actionBusy}
            onClick={() => setDeleteConfirmationOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={toolbarButtonClass}
            aria-label="Rename selected item"
            disabled={!primarySelection || actionBusy}
            onClick={beginRename}
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={toolbarButtonClass}
            aria-label="Quick Look"
            disabled={!primarySelection}
            onClick={() => void openQuickLook()}
          >
            <Eye className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={toolbarButtonClass}
            aria-label="Open selected file in Code"
            disabled={!primarySelection || primarySelection.directory}
            onClick={() => primarySelection && onOpenFile(primarySelection.path)}
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

        {showCreate ? (
          <form
            className="flex items-center gap-2 border-b border-white/8 bg-[#2574e8]/10 px-4 py-2"
            onSubmit={(event) => {
              event.preventDefault()
              void createFolder()
            }}
          >
            <Folder className="h-4 w-4 text-[#79b8ff]" />
            <input
              autoFocus
              aria-label="New folder name"
              value={newFolder}
              disabled={actionBusy}
              onChange={(event) => setNewFolder(event.target.value)}
              placeholder="New folder name"
              className="flex-1 rounded-md border border-white/12 bg-black/30 px-2 py-1 text-xs outline-none focus:border-[#79b8ff]/50"
            />
            <button
              type="submit"
              disabled={actionBusy}
              className="rounded-md bg-[#2574e8] px-3 py-1 text-xs font-medium disabled:opacity-50"
            >
              Create
            </button>
            <button type="button" className="px-2 py-1 text-xs text-white/55" onClick={() => setShowCreate(false)}>
              Cancel
            </button>
          </form>
        ) : null}

        {renaming ? (
          <form
            className="flex items-center gap-2 border-b border-white/8 bg-[#2574e8]/10 px-4 py-2"
            onSubmit={(event) => {
              event.preventDefault()
              void renameSelected()
            }}
          >
            <Pencil className="h-4 w-4 text-[#79b8ff]" />
            <input
              autoFocus
              aria-label="Rename item"
              value={renameValue}
              disabled={actionBusy}
              onChange={(event) => setRenameValue(event.target.value)}
              onFocus={(event) => {
                const extension = renaming.directory ? -1 : event.currentTarget.value.lastIndexOf('.')
                event.currentTarget.setSelectionRange(0, extension > 0 ? extension : event.currentTarget.value.length)
              }}
              className="flex-1 rounded-md border border-white/12 bg-black/30 px-2 py-1 text-xs outline-none focus:border-[#79b8ff]/50"
            />
            <button
              type="submit"
              disabled={actionBusy}
              className="rounded-md bg-[#2574e8] px-3 py-1 text-xs font-medium disabled:opacity-50"
            >
              Rename
            </button>
            <button type="button" className="px-2 py-1 text-xs text-white/55" onClick={() => setRenaming(null)}>
              Cancel
            </button>
          </form>
        ) : null}

        <div
          ref={contentRef}
          className="relative min-h-0 flex-1 overflow-auto p-3"
          onKeyDown={(event) => {
            if (event.key === ' ' && primarySelection && !event.repeat) {
              event.preventDefault()
              void openQuickLook()
            }
            if (event.key === 'F2' && primarySelection) {
              event.preventDefault()
              beginRename()
            }
          }}
          onPointerDown={beginDragSelection}
          onPointerMove={updateDragSelection}
          onPointerUp={finishDragSelection}
          onPointerCancel={finishDragSelection}
        >
          {selectionBox ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute z-20 border border-[#79b8ff]/70 bg-[#2574e8]/18"
              style={selectionBox}
            />
          ) : null}
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
                  elementRef={(element) => {
                    if (element) entryRefs.current.set(entry.path, element)
                    else entryRefs.current.delete(entry.path)
                  }}
                  entry={entry}
                  key={entry.path}
                  selected={selected.has(entry.path)}
                  view="list"
                  onActivate={() => activate(entry)}
                  onSelect={(event) => selectEntry(entry, event)}
                />
              ))}
            </div>
          ) : null}
          {!loading && !error && entries.length > 0 && view === 'grid' ? (
            <div role="group" aria-label="Files" className="grid grid-cols-[repeat(auto-fill,minmax(108px,1fr))] gap-2">
              {entries.map((entry) => (
                <FinderEntry
                  elementRef={(element) => {
                    if (element) entryRefs.current.set(entry.path, element)
                    else entryRefs.current.delete(entry.path)
                  }}
                  entry={entry}
                  key={entry.path}
                  selected={selected.has(entry.path)}
                  view="grid"
                  onActivate={() => activate(entry)}
                  onSelect={(event) => selectEntry(entry, event)}
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
            {entries.length} items{selected.size ? ` · ${selected.size} selected` : ''}
          </span>
          <span className={watchState === 'connected' ? 'text-emerald-300/60' : 'text-amber-200/65'}>
            {watchState === 'connected' ? 'Live' : 'Reconnecting…'}
          </span>
        </div>
      </div>

      <Dialog.Root open={Boolean(quickLook)} onOpenChange={(open) => !open && closeQuickLook()}>
        {quickLook ? (
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-[6800] bg-black/34 backdrop-blur-sm" />
            <Dialog.Content className="fixed top-1/2 left-1/2 z-[6801] flex h-[min(620px,calc(100vh-64px))] w-[min(820px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-white/18 bg-[#181b21]/96 shadow-2xl outline-none">
              <header className="flex h-11 shrink-0 items-center border-b border-white/9 px-4">
                <FinderFileIcon entry={quickLook.entry} />
                <Dialog.Title className="ml-2 min-w-0 flex-1 truncate text-xs font-semibold text-white/82">
                  {quickLook.entry.name}
                </Dialog.Title>
                <Dialog.Description className="sr-only">
                  Preview of {quickLook.entry.path}. Press Escape to close.
                </Dialog.Description>
                {!quickLook.entry.directory ? (
                  <button
                    type="button"
                    className="mr-2 rounded-lg px-2 py-1 text-xs text-[#79b8ff] hover:bg-white/7"
                    onClick={() => {
                      onOpenFile(quickLook.entry.path)
                      closeQuickLook()
                    }}
                  >
                    Open in Code
                  </button>
                ) : null}
                <Dialog.Close asChild>
                  <button type="button" className={toolbarButtonClass} aria-label="Close Quick Look">
                    <X className="h-4 w-4" />
                  </button>
                </Dialog.Close>
              </header>
              <div className="min-h-0 flex-1 overflow-auto p-5">
                {quickLook.entry.directory ? (
                  <div className="grid h-full place-items-center text-center text-white/45">
                    <div>
                      <FinderFileIcon entry={quickLook.entry} large />
                      <p className="mt-3 text-sm">{quickLook.entry.path}</p>
                    </div>
                  </div>
                ) : quickLook.loading ? (
                  <div className="flex h-full items-center justify-center gap-2 text-sm text-white/42">
                    <LoaderCircle className="h-4 w-4 animate-spin" /> Loading preview…
                  </div>
                ) : quickLook.error ? (
                  <p role="alert" className="rounded-xl bg-red-500/10 p-4 text-sm text-red-200">
                    {quickLook.error}
                  </p>
                ) : quickLook.content ? (
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-white/72">
                    {quickLook.content}
                  </pre>
                ) : (
                  <p className="text-center text-sm text-white/35">Empty file</p>
                )}
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        ) : null}
      </Dialog.Root>

      <ConfirmationDialog
        busy={actionBusy}
        confirmLabel="Delete"
        description={
          selectedEntries.length === 1
            ? `“${selectedEntries[0]?.name}” will be permanently removed from this agent’s workspace.`
            : `${selectedEntries.length} items will be permanently removed from this agent’s workspace.`
        }
        onConfirm={() => void deleteSelected()}
        onOpenChange={setDeleteConfirmationOpen}
        open={deleteConfirmationOpen}
        title={selectedEntries.length === 1 ? 'Delete this item?' : 'Delete selected items?'}
      />
    </div>
  )
}

function FinderEntry({
  elementRef,
  entry,
  onActivate,
  onSelect,
  selected,
  view,
}: {
  elementRef: (element: HTMLButtonElement | null) => void
  entry: TengriFileEntry
  onActivate: () => void
  onSelect: (event: ReactMouseEvent<HTMLButtonElement>) => void
  selected: boolean
  view: FinderView
}) {
  if (view === 'grid') {
    return (
      <button
        ref={elementRef}
        data-file-entry
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        onDoubleClick={onActivate}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          onActivate()
        }}
        className={`flex min-h-28 flex-col items-center justify-center gap-2 rounded-xl p-3 text-center text-xs ${selected ? 'bg-[#2574e8]/42' : 'hover:bg-white/6'}`}
      >
        <FinderFileIcon entry={entry} large />
        <span className="line-clamp-2 break-all">{entry.name}</span>
      </button>
    )
  }

  return (
    <button
      ref={elementRef}
      data-file-entry
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      onDoubleClick={onActivate}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        onActivate()
      }}
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
