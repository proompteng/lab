'use client'

import * as Dialog from '@radix-ui/react-dialog'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Eye,
  FileCode2,
  Folder,
  Grid2X2,
  List,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import Image from 'next/image'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'

import type { TengriFileEntry, TengriFileSearchResult } from '@/lib/tengri/types'
import { finderItemFormSchema, type FinderItemFormValues } from '@/schemas/finder-item'

import { runTengriAction } from './client'
import { ConfirmationDialog } from './confirmation-dialog'
import {
  FINDER_WORKSPACE_PATH,
  finderCanBeginRename,
  finderCanPreviewText,
  finderChildPath,
  finderDeletionDescription,
  finderDeletionTargets,
  finderBreadcrumbs,
  finderKindLabel,
  finderRenamePath,
  finderSearchRefreshInterval,
  formatFinderBytes,
  formatFinderDate,
  normalizeFinderPath,
  retainVisibleFinderEntry,
  sortFinderEntries,
  updateFinderSelection,
  type FinderSort,
} from './finder-model'

type FinderView = 'grid' | 'list'
export type FinderOpenRequest = { path: string; requestId: number }
type QuickLookState = {
  entry: TengriFileEntry
  content: string
  error: string
  loading: boolean
}

const toolbarButtonClass =
  'grid h-8 w-8 shrink-0 place-items-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-30'

const finderMenuItemClass =
  'flex h-7 cursor-default select-none items-center gap-2 rounded-[5px] px-2 text-[13px] outline-none data-[highlighted]:bg-[#2869ba] data-[highlighted]:text-white data-[disabled]:text-white/30'

const finderLocationSchema = z.object({
  path: z
    .string()
    .refine((value) => normalizeFinderPath(value) !== null, 'Enter an absolute path inside the workspace'),
})

const finderColumns = [
  { key: 'name', label: 'Name' },
  { key: 'modified', label: 'Date Modified' },
  { key: 'size', label: 'Size' },
  { key: 'kind', label: 'Kind' },
] as const

export function FinderApp({
  active,
  agentId,
  onOpenFile,
  request,
}: {
  active: boolean
  agentId: string
  onOpenFile?: (path: string) => void
  request?: FinderOpenRequest | null
}) {
  const [path, setPath] = useState(FINDER_WORKSPACE_PATH)
  const [history, setHistory] = useState<string[]>([FINDER_WORKSPACE_PATH])
  const [historyIndex, setHistoryIndex] = useState(0)
  const [entries, setEntries] = useState<TengriFileEntry[]>([])
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [view, setView] = useState<FinderView>('list')
  const [sort, setSort] = useState<FinderSort>({ column: 'name', direction: 'ascending' })
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [locationOpen, setLocationOpen] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [renaming, setRenaming] = useState<TengriFileEntry | null>(null)
  const [quickLook, setQuickLook] = useState<QuickLookState | null>(null)
  const [selectionBox, setSelectionBox] = useState<{ left: number; top: number; width: number; height: number } | null>(
    null,
  )
  const [loading, setLoading] = useState(true)
  const [searchTruncated, setSearchTruncated] = useState(false)
  const [watchState, setWatchState] = useState<'connected' | 'paused' | 'reconnecting'>('paused')
  const [error, setError] = useState('')
  const [deleteError, setDeleteError] = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false)
  const menuOpensSurface = useRef(false)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const locationForm = useForm<z.infer<typeof finderLocationSchema>>({
    defaultValues: { path: FINDER_WORKSPACE_PATH },
    resolver: zodResolver(finderLocationSchema),
  })
  const {
    formState: { errors: createFolderErrors },
    handleSubmit: handleCreateFolderSubmit,
    register: registerCreateFolder,
    reset: resetCreateFolder,
    setError: setCreateFolderError,
  } = useForm<FinderItemFormValues>({
    defaultValues: { name: '' },
    mode: 'onChange',
    resolver: zodResolver(finderItemFormSchema),
  })
  const {
    formState: { errors: renameErrors },
    handleSubmit: handleRenameSubmit,
    register: registerRename,
    reset: resetRename,
    setError: setRenameError,
  } = useForm<FinderItemFormValues>({
    defaultValues: { name: '' },
    mode: 'onChange',
    resolver: zodResolver(finderItemFormSchema),
  })
  const contentRef = useRef<HTMLDivElement | null>(null)
  const entryRefs = useRef(new Map<string, HTMLElement>())
  const inFlightLoad = useRef<{ key: string; promise: Promise<void> } | null>(null)
  const loadSequence = useRef(0)
  const latestLoad = useRef<(quiet?: boolean, signal?: AbortSignal, force?: boolean) => Promise<void>>(async () => {})
  const quickLookAbort = useRef<AbortController | null>(null)
  const consumedRequestId = useRef<number | null>(null)
  const selectionAnchor = useRef<string | null>(null)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    additive: Set<string>
    frame: number
  } | null>(null)

  const selectedEntries = entries.filter((entry) => selected.has(entry.path))
  const orderedEntries = useMemo(() => sortFinderEntries(entries, sort), [entries, sort])
  const breadcrumbs = finderBreadcrumbs(path)
  const folderName = breadcrumbs.at(-1)?.name ?? 'Workspace'
  const primarySelection = selectedEntries.length === 1 ? selectedEntries[0] : null
  const deletionTargets = finderDeletionTargets(selectedEntries)
  const createFolderError = createFolderErrors.name?.message ?? createFolderErrors.root?.server?.message
  const renameError = renameErrors.name?.message ?? renameErrors.root?.server?.message

  const load = useCallback(
    async (quiet = false, signal?: AbortSignal) => {
      const sequence = ++loadSequence.current
      if (!quiet) setLoading(true)
      setError('')
      try {
        const result = query.trim()
          ? await runTengriAction<TengriFileSearchResult>({ action: 'search-files', agentId, path, query }, signal)
          : await runTengriAction<{ path: string; entries: TengriFileEntry[] }>(
              { action: 'list-files', agentId, path },
              signal,
            )
        if (sequence !== loadSequence.current || signal?.aborted) return
        setEntries(result.entries)
        setSearchTruncated('truncated' in result && result.truncated)
        setRenaming((current) => retainVisibleFinderEntry(current, result.entries))
        if (selectionAnchor.current && !result.entries.some((entry) => entry.path === selectionAnchor.current)) {
          selectionAnchor.current = null
        }
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

  const invokeLoad = useCallback(
    (quiet = false, signal?: AbortSignal, force = false) => {
      const key = `${agentId}\n${path}\n${query}`
      if (!force && inFlightLoad.current?.key === key) return inFlightLoad.current.promise

      let request: { key: string; promise: Promise<void> }
      const promise = load(quiet, signal).finally(() => {
        if (inFlightLoad.current === request) inFlightLoad.current = null
      })
      request = { key, promise }
      inFlightLoad.current = request
      return promise
    },
    [agentId, load, path, query],
  )
  latestLoad.current = invokeLoad

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => void invokeLoad(false, controller.signal), query ? 180 : 0)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [active, invokeLoad, query])

  useEffect(() => {
    let refreshTimer = 0
    const source = new EventSource(
      `/api/tengri/files/events?agentId=${encodeURIComponent(agentId)}&path=${encodeURIComponent(path)}`,
    )
    source.onopen = () => {
      setWatchState('connected')
      void latestLoad.current(true)
    }
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

  useEffect(() => {
    const interval = finderSearchRefreshInterval(active, query)
    if (!interval) return
    const controller = new AbortController()
    let stopped = false
    let timer = 0
    const refresh = async () => {
      await latestLoad.current(true, controller.signal)
      if (!stopped) timer = window.setTimeout(refresh, interval)
    }
    timer = window.setTimeout(refresh, interval)
    return () => {
      stopped = true
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [active, agentId, path, query])

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
        setError('Enter an absolute path inside the workspace')
        return
      }
      setQuery('')
      setSelected(new Set())
      selectionAnchor.current = null
      setRenaming(null)
      setShowCreate(false)
      resetCreateFolder()
      resetRename()
      setError('')
      if (normalized === path) {
        void latestLoad.current(false, undefined, true)
        return
      }
      setPath(normalized)
      setHistory((current) => [...current.slice(0, historyIndex + 1), normalized])
      setHistoryIndex((index) => index + 1)
    },
    [historyIndex, path, resetCreateFolder, resetRename],
  )

  useEffect(() => {
    if (!request || consumedRequestId.current === request.requestId) return
    consumedRequestId.current = request.requestId
    navigate(request.path)
  }, [navigate, request])

  const navigateHistory = useCallback(
    (index: number) => {
      const nextPath = history[index]
      if (!nextPath) return
      setHistoryIndex(index)
      setPath(nextPath)
      setQuery('')
      setSelected(new Set())
      selectionAnchor.current = null
      setRenaming(null)
      setShowCreate(false)
      resetCreateFolder()
      resetRename()
      setError('')
    },
    [history, resetCreateFolder, resetRename],
  )

  const activate = useCallback(
    (entry: TengriFileEntry) => {
      if (entry.directory) navigate(entry.path)
      else onOpenFile?.(entry.path)
    },
    [navigate, onOpenFile],
  )

  const createFolder = handleCreateFolderSubmit(async ({ name }) => {
    const destination = finderChildPath(path, name)
    if (!destination) {
      setCreateFolderError('name', { message: 'Enter a valid folder name' })
      return
    }
    setActionBusy(true)
    try {
      await runTengriAction({ action: 'create-directory', agentId, path: destination })
      resetCreateFolder()
      setShowCreate(false)
      await latestLoad.current(true, undefined, true)
    } catch (cause) {
      setCreateFolderError('root.server', {
        message: cause instanceof Error ? cause.message : 'Finder could not create this folder',
      })
    } finally {
      setActionBusy(false)
    }
  })

  async function deleteSelected() {
    if (!deletionTargets.length) {
      setDeleteError('The workspace root cannot be deleted.')
      return
    }
    setActionBusy(true)
    setDeleteError('')
    try {
      for (const entry of deletionTargets) {
        await runTengriAction({ action: 'delete-file', agentId, path: entry.path, recursive: entry.directory })
      }
      setSelected(new Set())
      selectionAnchor.current = null
      setDeleteConfirmationOpen(false)
      await latestLoad.current(true, undefined, true)
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : 'Finder could not delete the selected items')
    } finally {
      setActionBusy(false)
    }
  }

  function beginRename(entry = primarySelection) {
    if (!finderCanBeginRename(entry, actionBusy)) return
    setShowCreate(false)
    resetCreateFolder()
    resetRename({ name: entry.name })
    setRenaming(entry)
  }

  const renameSelected = handleRenameSubmit(async ({ name }) => {
    if (!renaming) return
    const destinationPath = finderRenamePath(renaming.path, name)
    if (!destinationPath) {
      setRenameError('name', { message: 'Enter a valid name' })
      return
    }
    if (destinationPath === renaming.path) {
      setRenaming(null)
      resetRename()
      return
    }
    setActionBusy(true)
    try {
      await runTengriAction({ action: 'move-file', agentId, sourcePath: renaming.path, destinationPath })
      setSelected(new Set([destinationPath]))
      selectionAnchor.current = destinationPath
      setRenaming(null)
      resetRename()
      await latestLoad.current(true, undefined, true)
    } catch (cause) {
      setRenameError('root.server', {
        message: cause instanceof Error ? cause.message : 'Finder could not rename this item',
      })
    } finally {
      setActionBusy(false)
    }
  })

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
      const result = await runTengriAction<{ content: string; contentType: string }>(
        { action: 'read-file', agentId, path: entry.path },
        controller.signal,
      )
      if (controller.signal.aborted) return
      if (!finderCanPreviewText(result.contentType)) {
        setQuickLook({
          entry,
          content: '',
          error: `Quick Look cannot display ${result.contentType || 'this binary file'}.`,
          loading: false,
        })
        return
      }
      setQuickLook({ entry, content: result.content, error: '', loading: false })
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
    setSelected((current) => {
      const next = updateFinderSelection(current, orderedEntries, entry.path, selectionAnchor.current, {
        additive: event.metaKey || event.ctrlKey,
        range: event.shiftKey,
      })
      selectionAnchor.current = next.anchorPath
      return next.selected
    })
  }

  function focusEntry(entry: TengriFileEntry) {
    setSelected(new Set([entry.path]))
    selectionAnchor.current = entry.path
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
    if (!additive.size) {
      setSelected(new Set())
      selectionAnchor.current = null
    }
  }

  function applyDragSelection(
    drag: NonNullable<typeof dragRef.current>,
    host: HTMLDivElement,
    clientX: number,
    clientY: number,
  ) {
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
      ) {
        next.add(entryPath)
      }
    }
    setSelected(next)
    selectionAnchor.current = next.values().next().value ?? null
  }

  function updateDragSelection(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    const host = contentRef.current
    if (!drag || !host || drag.pointerId !== event.pointerId) return
    window.cancelAnimationFrame(drag.frame)
    const clientX = event.clientX
    const clientY = event.clientY
    drag.frame = window.requestAnimationFrame(() => applyDragSelection(drag, host, clientX, clientY))
  }

  function finishDragSelection(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    const host = contentRef.current
    if (!drag || !host || drag.pointerId !== event.pointerId) return
    window.cancelAnimationFrame(drag.frame)
    applyDragSelection(drag, host, event.clientX, event.clientY)
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    dragRef.current = null
    setSelectionBox(null)
  }

  function cancelDragSelection(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    window.cancelAnimationFrame(drag.frame)
    dragRef.current = null
    setSelectionBox(null)
  }

  function openLocation() {
    locationForm.reset({ path })
    setLocationOpen(true)
  }

  function handleFinderKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (
      event.defaultPrevented ||
      (event.target instanceof HTMLElement && event.target.closest('[role="dialog"], [role="menu"]'))
    )
      return
    if (event.metaKey || event.ctrlKey) {
      if (event.key.toLowerCase() === 'g' && event.shiftKey) {
        event.preventDefault()
        openLocation()
      } else if (event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setSearchOpen(true)
        searchRef.current?.focus()
      } else if (event.key === '1' || event.key === '2') {
        event.preventDefault()
        setView(event.key === '1' ? 'grid' : 'list')
      } else if (event.key === 'ArrowUp' && path !== FINDER_WORKSPACE_PATH) {
        event.preventDefault()
        navigate(breadcrumbs.at(-2)?.path ?? FINDER_WORKSPACE_PATH)
      }
    }
  }

  return (
    <div
      onKeyDown={handleFinderKeyDown}
      className="@container/finder relative flex h-full min-h-0 bg-zinc-900 text-[13px] text-white/85"
    >
      <aside
        aria-label="Finder sidebar"
        className="w-48 shrink-0 overflow-y-auto border-r border-black/25 bg-gradient-to-b from-[#2d3034] to-[#25272b] px-2.5 pt-[60px] pb-2.5 @max-[640px]/finder:hidden"
      >
        <div data-window-drag-region className="absolute top-0 left-0 h-[52px] w-48 touch-none select-none" />
        <p className="mb-1 px-2 py-1 text-[11px] font-semibold text-white/55">Favorites</p>
        <button
          type="button"
          aria-current={path === FINDER_WORKSPACE_PATH ? 'page' : undefined}
          onClick={() => navigate(FINDER_WORKSPACE_PATH)}
          className={`flex h-8 w-full items-center gap-2 rounded-[7px] px-2 text-left focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:outline-none ${path === FINDER_WORKSPACE_PATH ? 'bg-white/10 text-white' : 'text-white/75 hover:bg-white/[0.06]'}`}
        >
          <Folder aria-hidden="true" className="h-[18px] w-[18px] text-[#8ab8ea]" />
          Workspace
        </button>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div
          data-window-drag-region
          className="flex min-h-[52px] shrink-0 touch-none select-none items-center gap-2 border-b border-black/20 bg-gradient-to-b from-[#2e3033] to-[#282a2d] px-2.5 @max-[640px]/finder:flex-wrap @max-[640px]/finder:pt-[52px] @max-[640px]/finder:pb-2"
        >
          <div className="flex shrink-0 items-center rounded-full border border-white/[0.06]">
            <button
              type="button"
              aria-label="Back"
              disabled={historyIndex === 0}
              onClick={() => navigateHistory(historyIndex - 1)}
              className={toolbarButtonClass}
            >
              <ChevronLeft aria-hidden="true" className="h-[18px] w-[18px]" />
            </button>
            <button
              type="button"
              aria-label="Forward"
              disabled={historyIndex >= history.length - 1}
              onClick={() => navigateHistory(historyIndex + 1)}
              className={toolbarButtonClass}
            >
              <ChevronRight aria-hidden="true" className="h-[18px] w-[18px]" />
            </button>
          </div>
          <button
            type="button"
            aria-label="Go to folder"
            onClick={openLocation}
            title={path}
            className="mr-auto flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left font-semibold text-white/90 outline-none hover:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <span className="truncate">{query.trim() ? 'Search' : folderName}</span>
            <ChevronDown aria-hidden="true" className="h-3 w-3 shrink-0 text-white/45" />
          </button>
          <div
            role="group"
            aria-label="Finder view"
            className="flex shrink-0 rounded-full border border-white/[0.08] p-0.5"
          >
            <button
              type="button"
              className={`${toolbarButtonClass} ${view === 'grid' ? 'bg-white/[0.13] text-white' : ''}`}
              aria-label="Icon view"
              aria-pressed={view === 'grid'}
              onClick={() => setView('grid')}
            >
              <Grid2X2 aria-hidden="true" className="h-4 w-4" />
            </button>
            <button
              type="button"
              className={`${toolbarButtonClass} ${view === 'list' ? 'bg-white/[0.13] text-white' : ''}`}
              aria-label="List view"
              aria-pressed={view === 'list'}
              onClick={() => setView('list')}
            >
              <List aria-hidden="true" className="h-[18px] w-[18px]" />
            </button>
          </div>
          <div className="flex shrink-0 rounded-full border border-white/[0.08] p-0.5">
            <button
              type="button"
              className={toolbarButtonClass}
              aria-label="Quick Look"
              disabled={!primarySelection}
              onClick={() => void openQuickLook()}
            >
              <Eye aria-hidden="true" className="h-[18px] w-[18px]" />
            </button>
            <DropdownMenu.Root
              modal={false}
              onOpenChange={(open) => {
                if (open) menuOpensSurface.current = false
              }}
            >
              <DropdownMenu.Trigger asChild>
                <button type="button" aria-label="Finder actions" className={toolbarButtonClass}>
                  <MoreHorizontal aria-hidden="true" className="h-5 w-5" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  onCloseAutoFocus={(event) => {
                    if (menuOpensSurface.current) event.preventDefault()
                  }}
                  align="end"
                  sideOffset={6}
                  className="z-[6500] min-w-56 rounded-lg border border-white/20 bg-[#303134]/95 p-1 text-white/90 shadow-xl backdrop-blur-xl"
                >
                  <DropdownMenu.Item
                    className={finderMenuItemClass}
                    disabled={actionBusy}
                    onSelect={() => {
                      menuOpensSurface.current = true
                      setRenaming(null)
                      resetRename()
                      resetCreateFolder()
                      setShowCreate(true)
                    }}
                  >
                    <Plus className="h-4 w-4" />
                    New Folder
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className={finderMenuItemClass}
                    disabled={!primarySelection || primarySelection.path === FINDER_WORKSPACE_PATH || actionBusy}
                    onSelect={() => {
                      menuOpensSurface.current = true
                      beginRename()
                    }}
                  >
                    <Pencil className="h-4 w-4" />
                    Rename
                  </DropdownMenu.Item>
                  {onOpenFile ? (
                    <DropdownMenu.Item
                      className={finderMenuItemClass}
                      disabled={!primarySelection || primarySelection.directory}
                      onSelect={() => {
                        menuOpensSurface.current = true
                        if (primarySelection) onOpenFile(primarySelection.path)
                      }}
                    >
                      <FileCode2 className="h-4 w-4" />
                      Open in Code
                    </DropdownMenu.Item>
                  ) : null}
                  <DropdownMenu.Item
                    className={finderMenuItemClass}
                    disabled={!deletionTargets.length || actionBusy}
                    onSelect={() => {
                      menuOpensSurface.current = true
                      setDeleteError('')
                      setDeleteConfirmationOpen(true)
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete…
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator className="my-1 h-px bg-white/15" />
                  <DropdownMenu.Item
                    className={finderMenuItemClass}
                    onSelect={() => {
                      menuOpensSurface.current = true
                      openLocation()
                    }}
                  >
                    Go to Folder…<span className="ml-auto text-white/55">⇧⌘G</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator className="my-1 h-px bg-white/15" />
                  <DropdownMenu.Label className="px-2 py-1 text-[11px] text-white/55">Sort By</DropdownMenu.Label>
                  {finderColumns.map((column) => (
                    <DropdownMenu.CheckboxItem
                      key={column.key}
                      className={finderMenuItemClass}
                      checked={sort.column === column.key}
                      onSelect={() => setSort({ column: column.key, direction: 'ascending' })}
                    >
                      <span className="w-4">
                        <DropdownMenu.ItemIndicator>
                          <Check className="h-3.5 w-3.5" />
                        </DropdownMenu.ItemIndicator>
                      </span>
                      {column.label}
                    </DropdownMenu.CheckboxItem>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
          {searchOpen ? (
            <label className="flex h-8 w-40 shrink-0 items-center gap-1.5 rounded-full border border-white/15 bg-black/10 px-2.5 @max-[640px]/finder:w-full">
              <Search aria-hidden="true" className="h-4 w-4 text-white/60" />
              <input
                ref={searchRef}
                autoFocus
                value={query}
                aria-label="Search files"
                onChange={(event) => {
                  setQuery(event.target.value)
                  setSearchTruncated(false)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.stopPropagation()
                    setQuery('')
                    setSearchOpen(false)
                  }
                }}
                placeholder="Search"
                className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-white/55"
              />
              <button
                type="button"
                aria-label="Close search"
                onClick={() => {
                  setQuery('')
                  setSearchOpen(false)
                }}
                className="rounded-full text-white/65 outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                <X aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            </label>
          ) : (
            <button
              type="button"
              aria-label="Search files"
              onClick={() => setSearchOpen(true)}
              className={`${toolbarButtonClass} border border-white/[0.08]`}
            >
              <Search aria-hidden="true" className="h-[18px] w-[18px]" />
            </button>
          )}
        </div>

        {showCreate ? (
          <form
            noValidate
            className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1 border-b border-white/[0.08] bg-white/[0.035] px-3 py-1.5"
            onSubmit={createFolder}
          >
            <Folder aria-hidden="true" className="h-4 w-4 text-[#72a7e8]" />
            <input
              autoFocus
              aria-label="New folder name"
              aria-describedby={createFolderError ? 'create-folder-name-error' : undefined}
              aria-invalid={Boolean(createFolderError)}
              disabled={actionBusy}
              placeholder="New folder name"
              {...registerCreateFolder('name')}
              className="min-w-0 rounded-md border border-white/[0.12] bg-black/20 px-2 py-1 text-[12px] outline-none focus:border-white/35"
            />
            <div className="col-start-2 flex min-w-0 flex-wrap items-center gap-2">
              <button
                type="submit"
                disabled={actionBusy}
                className="rounded-md bg-white/[0.14] px-3 py-1 text-[12px] font-medium text-white/85 hover:bg-white/[0.2] focus-visible:ring-2 focus-visible:ring-white/35 focus-visible:outline-none disabled:opacity-50"
              >
                Create
              </button>
              <button
                type="button"
                disabled={actionBusy}
                className="rounded-md px-2 py-1 text-[12px] text-white/55 hover:bg-white/[0.07] focus-visible:ring-2 focus-visible:ring-white/35 focus-visible:outline-none disabled:opacity-40"
                onClick={() => {
                  setShowCreate(false)
                  resetCreateFolder()
                }}
              >
                Cancel
              </button>
              {createFolderError ? (
                <span id="create-folder-name-error" role="alert" className="min-w-0 basis-full text-xs text-red-200">
                  {createFolderError}
                </span>
              ) : null}
            </div>
          </form>
        ) : null}

        {renaming ? (
          <form
            noValidate
            className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1 border-b border-white/[0.08] bg-white/[0.035] px-3 py-1.5"
            onSubmit={renameSelected}
          >
            <Pencil aria-hidden="true" className="h-4 w-4 text-[#72a7e8]" />
            <input
              autoFocus
              aria-label="Rename item"
              aria-describedby={renameError ? 'rename-item-error' : undefined}
              aria-invalid={Boolean(renameError)}
              disabled={actionBusy}
              onFocus={(event) => {
                const extension = renaming.directory ? -1 : event.currentTarget.value.lastIndexOf('.')
                event.currentTarget.setSelectionRange(0, extension > 0 ? extension : event.currentTarget.value.length)
              }}
              {...registerRename('name')}
              className="min-w-0 rounded-md border border-white/[0.12] bg-black/20 px-2 py-1 text-[12px] outline-none focus:border-white/35"
            />
            <div className="col-start-2 flex min-w-0 flex-wrap items-center gap-2">
              <button
                type="submit"
                disabled={actionBusy}
                className="rounded-md bg-white/[0.14] px-3 py-1 text-[12px] font-medium text-white/85 hover:bg-white/[0.2] focus-visible:ring-2 focus-visible:ring-white/35 focus-visible:outline-none disabled:opacity-50"
              >
                Rename
              </button>
              <button
                type="button"
                disabled={actionBusy}
                className="rounded-md px-2 py-1 text-[12px] text-white/55 hover:bg-white/[0.07] focus-visible:ring-2 focus-visible:ring-white/35 focus-visible:outline-none disabled:opacity-40"
                onClick={() => {
                  setRenaming(null)
                  resetRename()
                }}
              >
                Cancel
              </button>
              {renameError ? (
                <span id="rename-item-error" role="alert" className="min-w-0 basis-full text-xs text-red-200">
                  {renameError}
                </span>
              ) : null}
            </div>
          </form>
        ) : null}

        <div
          ref={contentRef}
          className={`relative min-h-0 flex-1 overflow-auto bg-[#232527] ${view === 'grid' ? 'p-3' : 'px-2'}`}
          onPointerDown={beginDragSelection}
          onPointerMove={updateDragSelection}
          onPointerUp={finishDragSelection}
          onPointerCancel={cancelDragSelection}
        >
          {selectionBox ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute z-20 border border-white/45 bg-white/[0.1]"
              style={selectionBox}
            />
          ) : null}
          {loading ? (
            <div
              role="status"
              aria-label="Loading files"
              className="flex h-full items-center justify-center gap-2 text-[12px] text-white/55"
            >
              <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />
              Loading files…
            </div>
          ) : null}
          {!loading && error ? (
            <div
              role="alert"
              className="m-3 rounded-lg border border-red-400/20 bg-red-500/8 p-3 text-[12px] text-red-200"
            >
              {error}
            </div>
          ) : null}
          {!loading && !error && entries.length === 0 && query.trim() ? (
            <p className="pointer-events-none absolute inset-x-0 top-16 text-center text-[12px] text-white/60">
              No matching files
            </p>
          ) : null}
          {!loading && !error && view === 'list' ? (
            <div
              role="group"
              aria-label="Files"
              className="min-h-full min-w-[650px] bg-[repeating-linear-gradient(to_bottom,transparent_0px,transparent_22px,rgba(255,255,255,0.035)_22px,rgba(255,255,255,0.035)_44px)] [background-position:0_28px]"
            >
              <div className="sticky top-0 z-10 grid h-7 grid-cols-[minmax(220px,1fr)_170px_80px_140px] items-center border-b border-white/[0.08] bg-[#292b2d] text-[11px] font-medium text-white/65">
                {finderColumns.map((column) => (
                  <button
                    key={column.key}
                    type="button"
                    aria-label={`Sort by ${column.label}`}
                    aria-pressed={sort.column === column.key}
                    onClick={() =>
                      setSort((current) => ({
                        column: column.key,
                        direction:
                          current.column === column.key && current.direction === 'ascending'
                            ? 'descending'
                            : 'ascending',
                      }))
                    }
                    className="flex h-5 min-w-0 items-center gap-1 border-r border-white/[0.08] px-2 text-left last:border-r-0 focus-visible:outline-2 focus-visible:outline-blue-400"
                  >
                    <span className="flex-1">{column.label}</span>
                    {sort.column === column.key ? (
                      sort.direction === 'ascending' ? (
                        <ChevronUp aria-label="Ascending" className="h-3 w-3" />
                      ) : (
                        <ChevronDown aria-label="Descending" className="h-3 w-3" />
                      )
                    ) : null}
                  </button>
                ))}
              </div>
              {orderedEntries.map((entry) => (
                <FinderEntry
                  elementRef={(element) => {
                    if (element) entryRefs.current.set(entry.path, element)
                    else entryRefs.current.delete(entry.path)
                  }}
                  active={active}
                  entry={entry}
                  key={entry.path}
                  selected={selected.has(entry.path)}
                  showPath={Boolean(query.trim())}
                  view="list"
                  onActivate={() => activate(entry)}
                  onQuickLook={() => {
                    focusEntry(entry)
                    void openQuickLook(entry)
                  }}
                  onRename={() => {
                    focusEntry(entry)
                    beginRename(entry)
                  }}
                  onSelect={(event) => selectEntry(entry, event)}
                />
              ))}
            </div>
          ) : null}
          {!loading && !error && entries.length > 0 && view === 'grid' ? (
            <div
              role="group"
              aria-label="Files"
              className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] content-start gap-x-2 gap-y-3"
            >
              {orderedEntries.map((entry) => (
                <FinderEntry
                  elementRef={(element) => {
                    if (element) entryRefs.current.set(entry.path, element)
                    else entryRefs.current.delete(entry.path)
                  }}
                  active={active}
                  entry={entry}
                  key={entry.path}
                  selected={selected.has(entry.path)}
                  showPath={Boolean(query.trim())}
                  view="grid"
                  onActivate={() => activate(entry)}
                  onQuickLook={() => {
                    focusEntry(entry)
                    void openQuickLook(entry)
                  }}
                  onRename={() => {
                    focusEntry(entry)
                    beginRename(entry)
                  }}
                  onSelect={(event) => selectEntry(entry, event)}
                />
              ))}
            </div>
          ) : null}
        </div>

        <nav
          aria-label="Folder path"
          className="flex h-7 shrink-0 items-center gap-1 overflow-x-auto border-t border-black/25 bg-[#282a2d] px-3 text-[11px] text-white/70"
        >
          {breadcrumbs.map((crumb, index) => (
            <span key={crumb.path} className="flex shrink-0 items-center gap-1">
              {index > 0 ? <ChevronRight aria-hidden="true" className="h-3 w-3 text-white/40" /> : null}
              <button
                type="button"
                onClick={() => navigate(crumb.path)}
                aria-current={path === crumb.path ? 'page' : undefined}
                className="flex max-w-48 items-center gap-1 rounded px-1 py-0.5 outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                <Image
                  src="/tengri/icons/folder.png"
                  alt=""
                  width={16}
                  height={16}
                  className="h-3.5 w-3.5"
                  unoptimized
                  draggable={false}
                />
                <span className="truncate">{crumb.name}</span>
              </button>
            </span>
          ))}
        </nav>
        <div
          role="status"
          aria-label="Folder status"
          className="flex h-6 shrink-0 items-center justify-center gap-2 border-t border-white/[0.04] bg-[#282a2d] px-3 text-[11px] text-white/60"
        >
          <span>
            {searchTruncated
              ? 'Search limit reached · Narrow your search'
              : selected.size
                ? `${selected.size} of ${entries.length} selected`
                : `${entries.length} ${entries.length === 1 ? 'item' : 'items'}`}
          </span>
          {watchState === 'reconnecting' ? <span className="text-amber-200/85">· Reconnecting…</span> : null}
        </div>
      </div>

      <Dialog.Root open={locationOpen} onOpenChange={setLocationOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[6800] bg-black/20" />
          <Dialog.Content
            data-tengri-modal="true"
            className="fixed top-[24%] left-1/2 z-[6801] w-[min(520px,calc(100vw-32px))] -translate-x-1/2 rounded-xl border border-white/20 bg-[#2e3033] p-4 text-white/85 shadow-2xl outline-none"
          >
            <Dialog.Title className="text-[13px] font-semibold">Go to Folder</Dialog.Title>
            <Dialog.Description className="mt-1 text-[12px] text-white/60">
              Enter a path in your workspace.
            </Dialog.Description>
            <form
              noValidate
              onSubmit={locationForm.handleSubmit(({ path: destination }) => {
                navigate(destination)
                setLocationOpen(false)
              })}
              className="mt-3"
            >
              <input
                autoFocus
                aria-label="Folder location"
                aria-invalid={Boolean(locationForm.formState.errors.path)}
                aria-describedby={locationForm.formState.errors.path ? 'finder-location-error' : undefined}
                {...locationForm.register('path')}
                onFocus={(event) => event.currentTarget.select()}
                className="h-8 w-full rounded-md border border-white/25 bg-black/20 px-2 text-[13px] outline-none focus:ring-2 focus:ring-blue-400"
              />
              {locationForm.formState.errors.path ? (
                <p id="finder-location-error" role="alert" className="mt-2 text-xs text-red-200">
                  {locationForm.formState.errors.path.message}
                </p>
              ) : null}
              <div className="mt-3 flex justify-end gap-2">
                <Dialog.Close className="rounded-md bg-white/10 px-3 py-1 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
                  Cancel
                </Dialog.Close>
                <button
                  type="submit"
                  className="rounded-md bg-[#2869ba] px-4 py-1 text-[12px] text-white outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                >
                  Go
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={Boolean(quickLook)} onOpenChange={(open) => !open && closeQuickLook()}>
        {quickLook ? (
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-[6800] bg-black/34 backdrop-blur-sm" />
            <Dialog.Content
              data-tengri-modal="true"
              className="fixed top-1/2 left-1/2 z-[6801] flex h-[min(620px,calc(100vh-64px))] w-[min(820px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-white/[0.14] bg-[#242527]/96 shadow-2xl outline-none"
            >
              <header className="flex h-10 shrink-0 items-center border-b border-white/[0.1] bg-white/[0.025] px-3">
                <FinderFileIcon entry={quickLook.entry} />
                <Dialog.Title className="ml-2 min-w-0 flex-1 truncate text-[12px] font-semibold text-white/82">
                  {quickLook.entry.name}
                </Dialog.Title>
                <Dialog.Description className="sr-only">
                  Preview of {quickLook.entry.path}. Press Escape to close.
                </Dialog.Description>
                {!quickLook.entry.directory && onOpenFile ? (
                  <button
                    type="button"
                    className="mr-2 rounded-md px-2 py-1 text-[12px] text-white/65 hover:bg-white/[0.07] focus-visible:ring-2 focus-visible:ring-white/35 focus-visible:outline-none"
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
              <div className="min-h-0 flex-1 overflow-auto p-4">
                {quickLook.entry.directory ? (
                  <div className="grid h-full place-items-center text-center text-white/55">
                    <div>
                      <FinderFileIcon entry={quickLook.entry} large />
                      <p className="mt-3 text-[12px]">{quickLook.entry.path}</p>
                    </div>
                  </div>
                ) : quickLook.loading ? (
                  <div className="flex h-full items-center justify-center gap-2 text-[12px] text-white/55">
                    <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> Loading preview…
                  </div>
                ) : quickLook.error ? (
                  <p role="alert" className="rounded-lg bg-red-500/10 p-3 text-[12px] text-red-200">
                    {quickLook.error}
                  </p>
                ) : quickLook.content ? (
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-white/72">
                    {quickLook.content}
                  </pre>
                ) : (
                  <p className="text-center text-[12px] text-white/55">Empty file</p>
                )}
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        ) : null}
      </Dialog.Root>

      <ConfirmationDialog
        busy={actionBusy}
        confirmLabel="Delete"
        description={finderDeletionDescription(deletionTargets)}
        error={deleteError}
        onCancel={() => {
          if (actionBusy) return
          setDeleteConfirmationOpen(false)
          setDeleteError('')
        }}
        onConfirm={() => void deleteSelected()}
        open={deleteConfirmationOpen}
        title={deletionTargets.length === 1 ? 'Delete this item?' : 'Delete selected items?'}
      />
    </div>
  )
}

function FinderEntry({
  active,
  elementRef,
  entry,
  onActivate,
  onQuickLook,
  onRename,
  onSelect,
  selected,
  showPath,
  view,
}: {
  active: boolean
  elementRef: (element: HTMLButtonElement | null) => void
  entry: TengriFileEntry
  onActivate: () => void
  onQuickLook: () => void
  onRename: () => void
  onSelect: (event: ReactMouseEvent<HTMLButtonElement>) => void
  selected: boolean
  showPath: boolean
  view: FinderView
}) {
  function handleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      onActivate()
      return
    }
    if (event.key === ' ' && !event.repeat) {
      event.preventDefault()
      onQuickLook()
      return
    }
    if (event.key === 'F2') {
      event.preventDefault()
      onRename()
    }
  }

  if (view === 'grid') {
    return (
      <button
        ref={elementRef}
        data-file-entry
        type="button"
        aria-label={entry.name}
        aria-pressed={selected}
        onClick={onSelect}
        onDoubleClick={onActivate}
        onKeyDown={handleKeyDown}
        className="flex min-h-28 flex-col items-center gap-1 rounded-md p-1 text-center text-[12px] focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:outline-none"
      >
        <span className={`grid h-[72px] w-[76px] place-items-center rounded-md ${selected ? 'bg-white/10' : ''}`}>
          <FinderFileIcon entry={entry} large />
        </span>
        <span
          className={`line-clamp-2 rounded px-1 break-words ${selected ? (active ? 'bg-[#2869ba] text-white' : 'bg-white/20 text-white') : ''}`}
        >
          {entry.name}
        </span>
        {showPath ? <span className="line-clamp-2 break-all text-[10px] text-white/55">{entry.path}</span> : null}
      </button>
    )
  }

  return (
    <button
      ref={elementRef}
      data-file-entry
      type="button"
      aria-label={entry.name}
      aria-pressed={selected}
      onClick={onSelect}
      onDoubleClick={onActivate}
      onKeyDown={handleKeyDown}
      className={`grid min-h-[22px] w-full grid-cols-[minmax(220px,1fr)_170px_80px_140px] items-center rounded-[5px] text-left text-[12px] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400 focus-visible:outline-none ${selected ? (active ? 'bg-[#2869ba] text-white' : 'bg-white/15 text-white') : 'hover:bg-white/[0.04]'}`}
    >
      <span className="flex min-w-0 items-center gap-1.5 px-2">
        <FinderFileIcon entry={entry} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{entry.name}</span>
          {showPath ? <span className="truncate text-[10px] text-white/55">{entry.path}</span> : null}
        </span>
      </span>
      <span className={`truncate px-2 ${selected && active ? 'text-white/90' : 'text-white/60'}`}>
        {formatFinderDate(entry.modifiedAt)}
      </span>
      <span className={`truncate px-2 text-right ${selected && active ? 'text-white/90' : 'text-white/60'}`}>
        {entry.directory ? '—' : formatFinderBytes(entry.size)}
      </span>
      <span className={`truncate px-2 ${selected && active ? 'text-white/90' : 'text-white/60'}`}>
        {finderKindLabel(entry)}
      </span>
    </button>
  )
}

function FinderFileIcon({ entry, large = false }: { entry: TengriFileEntry; large?: boolean }) {
  return (
    <Image
      src={`/tengri/icons/${entry.directory ? 'folder' : 'document'}.png`}
      alt=""
      width={large ? 64 : 16}
      height={large ? 64 : 16}
      className={large ? 'h-16 w-16 shrink-0 object-contain' : 'h-4 w-4 shrink-0 object-contain'}
      unoptimized
      draggable={false}
    />
  )
}
