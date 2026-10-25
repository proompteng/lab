'use client'

import { createContext, memo, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowUp, FileText, Folder, Pin, PinOff, RotateCw, X } from 'lucide-react'
import type { TengriFileEntry, TengriFileList } from '@/lib/tengri/types'
import { remarkWorkspaceImageBudget } from './markdown-image-budget'
import { isWorkspaceImagePath } from '@/lib/tengri/codex-images'
import { runTengriAction } from './client'
import { FINDER_WORKSPACE_PATH, finderCanPreviewText } from './finder-model'
import { parseWorkspaceFileLink, type WorkspaceFileTarget as FileTarget } from './workspace-file-link-model'
import {
  emptyWorkspaceResources,
  MAX_WORKSPACE_RESOURCES,
  readWorkspacePins,
  readWorkspaceResources,
  workspacePinsKey,
  writeWorkspacePins,
  writeWorkspaceResources,
} from './workspace-resource-storage'

const WorkspaceFileLinkContext = createContext<((file: FileTarget) => void) | null>(null)
const WorkspaceAgentContext = createContext<string | null>(null)
const WorkspaceResourcesContext = createContext<{
  agentId: string
  files: FileTarget[]
  pins: FileTarget[]
  activePath: string | null
  storageAvailable: boolean
  openFile: (file: FileTarget) => void
  closeFile: (path: string) => void
  showChat: () => void
  togglePin: (file: FileTarget) => void
} | null>(null)
const MAX_PREVIEW_CHARACTERS = 200_000
const MAX_PREVIEW_LINES = 5_000

export function WorkspaceFileLinkProvider({ agentId, children }: { agentId: string; children?: ReactNode }) {
  const [resources, setResources] = useState(emptyWorkspaceResources)
  const [pins, setPins] = useState<FileTarget[]>([])
  const [loaded, setLoaded] = useState(false)
  const [storageAvailable, setStorageAvailable] = useState(true)
  useEffect(() => {
    setResources(readWorkspaceResources(agentId))
    setPins(readWorkspacePins(agentId))
    setLoaded(true)
    const syncPins = (event: StorageEvent) => {
      if (!event.key || event.key === workspacePinsKey(agentId)) setPins(readWorkspacePins(agentId))
    }
    window.addEventListener('storage', syncPins)
    return () => window.removeEventListener('storage', syncPins)
  }, [agentId])
  useEffect(() => {
    if (loaded && !writeWorkspaceResources(agentId, resources)) setStorageAvailable(false)
  }, [agentId, resources, loaded])
  const openFile = useCallback((file: FileTarget) => {
    setResources((current) => ({
      tabs: (current.tabs.some((item) => item.path === file.path)
        ? current.tabs.map((item) => (item.path === file.path ? file : item))
        : [...current.tabs, file]
      ).slice(-MAX_WORKSPACE_RESOURCES),
      activePath: file.path,
    }))
  }, [])
  const showChat = useCallback(() => setResources((current) => ({ ...current, activePath: null })), [])
  const closeFile = (path: string) =>
    setResources((current) => ({
      tabs: current.tabs.filter((file) => file.path !== path),
      activePath: current.activePath === path ? null : current.activePath,
    }))
  const togglePin = (file: FileTarget) => {
    const pinned = pins.some((item) => item.path === file.path)
    if (!pinned && pins.length >= MAX_WORKSPACE_RESOURCES) return
    const next = pinned ? pins.filter((item) => item.path !== file.path) : [...pins, file]
    setPins(next)
    if (!writeWorkspacePins(agentId, next)) setStorageAvailable(false)
  }
  return (
    <WorkspaceResourcesContext.Provider
      value={{
        agentId,
        files: resources.tabs,
        pins,
        activePath: resources.activePath,
        storageAvailable,
        openFile,
        closeFile,
        showChat,
        togglePin,
      }}
    >
      <WorkspaceFileLinkContext.Provider value={openFile}>
        <WorkspaceAgentContext.Provider value={agentId}>{children}</WorkspaceAgentContext.Provider>
      </WorkspaceFileLinkContext.Provider>
    </WorkspaceResourcesContext.Provider>
  )
}

export function useWorkspaceResources() {
  const context = useContext(WorkspaceResourcesContext)
  if (!context) throw new Error('Workspace resources require their provider')
  return context
}

export function WorkspacePinnedResources({ onOpen }: { onOpen: () => void }) {
  const { pins, openFile, togglePin, storageAvailable } = useWorkspaceResources()
  return (
    <>
      {pins.length ? (
        <nav aria-label="Pinned resources" className="shrink-0 border-b border-white/[0.06] px-1.5 pb-2">
          <h2 className="px-2.5 py-2 text-label-12 text-zinc-400">Pinned</h2>
          <ul>
            {pins.map((file) => (
              <li key={file.path} className="group flex min-w-0 items-center rounded-md hover:bg-white/[0.03]">
                <button
                  type="button"
                  aria-label={`Open ${file.path}`}
                  title={`${file.path}${file.line ? `:${file.line}${file.column ? `:${file.column}` : ''}` : ''}`}
                  onClick={() => {
                    openFile(file)
                    onOpen()
                  }}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 py-2 text-left text-label-12 text-zinc-400 outline-none hover:text-zinc-100 focus-visible:ring-1 focus-visible:ring-blue-400"
                >
                  <FileText className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{file.path.split('/').at(-1)}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Unpin resource ${file.path}`}
                  onClick={() => togglePin(file)}
                  className="mr-1 grid size-7 shrink-0 place-items-center rounded text-zinc-500 outline-none hover:bg-white/[0.06] hover:text-zinc-200 focus-visible:ring-1 focus-visible:ring-blue-400"
                >
                  <PinOff className="size-3" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      {!storageAvailable ? (
        <p role="status" className="px-3 py-2 text-label-12 text-zinc-400">
          Pins and tabs will last until you close this window.
        </p>
      ) : null}
    </>
  )
}

export function WorkspaceFileTabs({ children }: { children: ReactNode }) {
  const { agentId, files, activePath, closeFile: removeFile, showChat, openFile } = useWorkspaceResources()
  const [hoveredPath, setHoveredPath] = useState<string | null>(null)
  const [focusedPath, setFocusedPath] = useState<string | null>(null)
  const id = useId()
  const activeFile = files.find((file) => file.path === activePath)
  useEffect(() => {
    if (activePath)
      document.getElementById(`${id}-file-${files.findIndex((file) => file.path === activePath)}`)?.focus()
  }, [activePath, files, id])
  const closeFile = (path: string) => {
    removeFile(path)
    setHoveredPath(null)
    setFocusedPath(null)
    if (!activePath || activePath === path) {
      document.getElementById(`${id}-chat`)?.focus()
    }
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        className="grid shrink-0 overflow-x-auto border-b border-zinc-800 bg-zinc-950"
        style={{
          gridTemplateColumns: files.length ? `repeat(${files.length + 1}, minmax(7rem, 14rem))` : 'max-content',
        }}
      >
        <div
          role="tablist"
          aria-label="Agent views"
          className="col-span-full row-start-1 grid grid-cols-subgrid"
          onKeyDown={(event) => {
            const focusedTab = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="tab"]')
            const closePath = focusedTab?.dataset.filePath
            if (event.key === 'Delete' && closePath) {
              event.preventDefault()
              closeFile(closePath)
              return
            }
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
            const index = tabs.indexOf(document.activeElement as HTMLButtonElement)
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? tabs.length - 1
                  : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
            event.preventDefault()
            tabs[next]?.focus()
            tabs[next]?.click()
          }}
        >
          <button
            role="tab"
            id={`${id}-chat`}
            aria-controls={`${id}-chat-panel`}
            aria-selected={!activeFile}
            tabIndex={activeFile ? -1 : 0}
            type="button"
            onClick={showChat}
            className={`min-w-0 border-b-2 py-2 text-left text-label-12 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-blue-400 ${files.length ? 'px-3 pr-8' : 'px-4'} ${!activeFile ? 'border-blue-400 text-zinc-100' : 'border-transparent text-zinc-400'}`}
          >
            Chat
          </button>
          {files.map((file, index) => (
            <button
              key={file.path}
              role="tab"
              id={`${id}-file-${index}`}
              data-file-path={file.path}
              aria-controls={`${id}-file-panel-${index}`}
              aria-describedby={`${id}-close-hint`}
              aria-selected={activePath === file.path}
              tabIndex={activePath === file.path ? 0 : -1}
              title={file.path}
              type="button"
              onClick={() => openFile(file)}
              onPointerEnter={() => setHoveredPath(file.path)}
              onPointerLeave={() => setHoveredPath(null)}
              onFocus={() => setFocusedPath(file.path)}
              onBlur={() => setFocusedPath(null)}
              className={`flex min-w-0 items-center border-b-2 px-3 py-2 pr-8 text-left text-label-12 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-blue-400 ${activePath === file.path ? 'border-blue-400 text-zinc-100' : 'border-transparent text-zinc-400'}`}
            >
              <span className="min-w-0 flex-1 truncate">{file.path.split('/').at(-1)}</span>
            </button>
          ))}
        </div>
        {/* Close buttons share the tab grid without being nested inside tabs or the tablist. */}
        {files.map((file, index) => (
          <div
            key={file.path}
            className="pointer-events-none relative row-start-1 min-w-0"
            style={{ gridColumn: index + 2 }}
          >
            <button
              type="button"
              aria-label={`Close ${file.path}`}
              title={`Close ${file.path}`}
              tabIndex={activePath === file.path ? 0 : -1}
              onClick={() => closeFile(file.path)}
              onPointerEnter={() => setHoveredPath(file.path)}
              onPointerLeave={() => setHoveredPath(null)}
              onFocus={() => setFocusedPath(file.path)}
              onBlur={() => setFocusedPath(null)}
              className={`pointer-events-auto absolute top-1/2 right-1 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded text-zinc-400 outline-none transition-opacity hover:bg-white/[0.08] hover:text-zinc-100 focus-visible:ring-1 focus-visible:ring-blue-400 motion-reduce:transition-none [@media(hover:none)]:opacity-100 ${hoveredPath === file.path || focusedPath === file.path ? 'opacity-100' : 'opacity-0'}`}
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
      <span id={`${id}-close-hint`} className="sr-only">
        Press Delete to close this tab.
      </span>
      <div
        role="tabpanel"
        id={`${id}-chat-panel`}
        aria-labelledby={`${id}-chat`}
        hidden={Boolean(activeFile)}
        className={activeFile ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}
      >
        {children}
      </div>
      {files.map((file, index) => (
        <div
          key={file.path}
          role="tabpanel"
          id={`${id}-file-panel-${index}`}
          aria-labelledby={`${id}-file-${index}`}
          hidden={activePath !== file.path}
          className={activePath === file.path ? 'min-h-0 flex-1' : 'hidden'}
        >
          <FilePreview
            key={`${agentId}:${file.path}:${file.line}:${file.column}`}
            agentId={agentId}
            file={file}
            active={activePath === file.path}
          />
        </div>
      ))}
    </div>
  )
}

const FilePreview = memo(function FilePreview({
  agentId,
  file,
  active,
}: {
  agentId: string
  file: FileTarget
  active: boolean
}) {
  const { pins, togglePin, openFile } = useWorkspaceResources()
  const pinned = pins.some((item) => item.path === file.path)
  const [result, setResult] = useState<
    | { kind: 'directory'; entries: TengriFileEntry[] }
    | { kind: 'file'; content: string; contentType: string }
    | { kind: 'image' }
    | null
  >(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [source, setSource] = useState(false)
  const selectedLine = useRef<HTMLSpanElement>(null)
  const markdown = /\.(md|markdown|mdown)$/i.test(file.path)
  const image = result?.kind === 'image'
  const directory = result?.kind === 'directory'
  const parentPath = file.path.slice(0, file.path.lastIndexOf('/'))
  useEffect(() => {
    if (!active || result || error) return
    const controller = new AbortController()
    async function load() {
      const metadata = await runTengriAction<TengriFileEntry>(
        { action: 'stat-file', agentId, path: file.path },
        controller.signal,
      )
      if (metadata.directory) {
        const folder = await runTengriAction<TengriFileList>(
          { action: 'list-files', agentId, path: file.path },
          controller.signal,
        )
        if (!controller.signal.aborted) setResult({ kind: 'directory', entries: folder.entries })
      } else if (isWorkspaceImagePath(file.path)) {
        if (!controller.signal.aborted) setResult({ kind: 'image' })
      } else {
        const value = await runTengriAction<{ content: string; contentType: string }>(
          { action: 'read-file', agentId, path: file.path },
          controller.signal,
        )
        if (controller.signal.aborted) return
        if (!finderCanPreviewText(value.contentType)) throw new Error('This file type cannot be previewed as text.')
        setResult({ kind: 'file', ...value })
      }
    }
    void load().catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not open this resource.')
    })
    return () => controller.abort()
  }, [agentId, file.path, attempt, active, result, error])
  useEffect(() => {
    selectedLine.current?.scrollIntoView({ block: 'nearest' })
  }, [result, source, active])
  if (!active) return null
  const content = result?.kind === 'file' ? result.content.slice(0, MAX_PREVIEW_CHARACTERS) : ''
  const lines = content.split('\n')
  const truncated =
    (result?.kind === 'file' && result.content.length > MAX_PREVIEW_CHARACTERS) ||
    ((source || !markdown) && lines.length > MAX_PREVIEW_LINES)
  const showSource = source || !markdown
  return (
    <section
      aria-label={directory ? 'Folder preview' : 'File preview'}
      className="flex h-full min-h-0 flex-col border-t border-zinc-700 bg-zinc-950 text-copy-14 text-zinc-200"
    >
      <div className="flex items-center gap-3 border-b border-zinc-800 px-3 py-1.5">
        <h2 className="min-w-0 flex-1 truncate text-label-12" title={file.path}>
          {file.path}
          {file.line ? `:${file.line}${file.column ? `:${file.column}` : ''}` : ''}
        </h2>
        <button
          type="button"
          aria-label={`${pinned ? 'Unpin' : 'Pin'} ${file.path}`}
          title={
            !pinned && pins.length >= MAX_WORKSPACE_RESOURCES
              ? 'Unpin a resource to add another'
              : `${pinned ? 'Unpin' : 'Pin'} this resource`
          }
          disabled={!pinned && pins.length >= MAX_WORKSPACE_RESOURCES}
          onClick={() => togglePin(file)}
          className="grid size-7 shrink-0 place-items-center rounded text-zinc-400 outline-none hover:bg-white/[0.06] hover:text-zinc-100 focus-visible:ring-1 focus-visible:ring-blue-400 disabled:opacity-40"
        >
          <Pin className={`size-3.5 ${pinned ? 'fill-current text-zinc-200' : ''}`} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Refresh resource"
          onClick={() => {
            setResult(null)
            setError('')
            setAttempt((value) => value + 1)
          }}
          className="grid size-7 shrink-0 place-items-center rounded text-zinc-400 outline-none hover:bg-white/[0.06] hover:text-zinc-100 focus-visible:ring-1 focus-visible:ring-blue-400"
        >
          <RotateCw className="size-3.5" aria-hidden="true" />
        </button>
        {markdown && result?.kind === 'file' ? (
          <div role="group" aria-label="Markdown view" className="inline-flex shrink-0 items-center gap-2">
            {[
              { label: 'Preview', value: false },
              { label: 'Source', value: true },
            ].map(({ label, value }) => (
              <button
                key={label}
                type="button"
                aria-pressed={source === value}
                onClick={() => setSource(value)}
                className={`border-b py-0.5 text-label-12 outline-none focus-visible:ring-1 focus-visible:ring-blue-400 [@media(pointer:coarse)]:min-h-6 ${source === value ? 'border-zinc-400 text-zinc-200' : 'border-transparent text-zinc-400 hover:text-zinc-200'}`}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="min-h-0 overflow-auto p-3">
        {image && active ? <WorkspaceImage src={file.path} alt={file.path.split('/').at(-1)} /> : null}
        {!result && !error ? <p role="status">Loading resource…</p> : null}
        {result?.kind === 'directory' ? (
          <>
            {file.path !== FINDER_WORKSPACE_PATH ? (
              <button
                type="button"
                aria-label="Parent folder"
                onClick={() => openFile({ path: parentPath })}
                className="mb-2 inline-flex items-center gap-2 rounded px-2 py-1 text-zinc-400 outline-none hover:bg-white/[0.06] hover:text-zinc-100 focus-visible:ring-1 focus-visible:ring-blue-400"
              >
                <ArrowUp className="size-3.5" aria-hidden="true" />
                Parent folder
              </button>
            ) : null}
            {result.entries.length ? (
              <ul aria-label="Folder contents" className="space-y-0.5">
                {[...result.entries]
                  .sort(
                    (left, right) =>
                      Number(right.directory) - Number(left.directory) || left.name.localeCompare(right.name),
                  )
                  .map((entry) => (
                    <li key={entry.path}>
                      <button
                        type="button"
                        aria-label={`Open ${entry.path}`}
                        onClick={() => openFile({ path: entry.path })}
                        className="flex w-full min-w-0 items-center gap-2 rounded px-2 py-2 text-left outline-none hover:bg-white/[0.06] focus-visible:ring-1 focus-visible:ring-blue-400"
                      >
                        {entry.directory ? (
                          <Folder className="size-4 shrink-0 text-zinc-400" aria-hidden="true" />
                        ) : (
                          <FileText className="size-4 shrink-0 text-zinc-400" aria-hidden="true" />
                        )}
                        <span className="truncate">{entry.name}</span>
                      </button>
                    </li>
                  ))}
              </ul>
            ) : (
              <p className="px-2 py-3 text-zinc-400">This folder is empty.</p>
            )}
          </>
        ) : null}
        {error ? (
          <div role="alert">
            <p>{error}</p>
            <button
              type="button"
              className="mt-2 text-blue-300"
              onClick={() => {
                setError('')
                setAttempt((value) => value + 1)
              }}
            >
              Retry file preview
            </button>
          </div>
        ) : null}
        {result?.kind === 'file' ? (
          showSource ? (
            <pre className="text-copy-13-mono">
              <code>
                {lines.slice(0, MAX_PREVIEW_LINES).map((line, index) => (
                  <span
                    key={index}
                    ref={index + 1 === file.line ? selectedLine : undefined}
                    data-selected={index + 1 === file.line ? 'true' : undefined}
                    className={`block min-w-fit ${index + 1 === file.line ? 'bg-blue-500/20' : ''}`}
                  >
                    <span aria-hidden="true" className="mr-4 inline-block w-10 select-none text-right text-zinc-500">
                      {index + 1}
                    </span>
                    {line || ' '}
                    {'\n'}
                  </span>
                ))}
              </code>
            </pre>
          ) : (
            <div className="break-words [&_h1]:my-3 [&_h1]:text-heading-20 [&_h2]:my-3 [&_h2]:text-heading-16 [&_h3]:my-2 [&_h3]:text-heading-14 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-auto [&_pre]:p-3 [&_pre]:bg-zinc-900 [&_code]:font-mono [&_table]:block [&_table]:overflow-auto [&_td]:p-2 [&_th]:p-2 [&_blockquote]:border-l [&_blockquote]:pl-3">
              <ReactMarkdown
                remarkPlugins={[remarkGfm, [remarkWorkspaceImageBudget, { basePath: file.path }]]}
                components={{
                  a: ({ href, children }) => (
                    <WorkspaceFileLink href={href} basePath={file.path}>
                      {children}
                    </WorkspaceFileLink>
                  ),
                  img: ({ src, alt }) => (
                    <WorkspaceImage src={typeof src === 'string' ? src : undefined} alt={alt} basePath={file.path} />
                  ),
                }}
              >
                {content}
              </ReactMarkdown>
            </div>
          )
        ) : null}
        {truncated ? (
          <p role="status" className="mt-2 text-zinc-400">
            Preview truncated. Only the first {showSource ? '5,000 lines or ' : ''}200,000 characters are shown.
          </p>
        ) : null}
      </div>
    </section>
  )
})

export function WorkspaceFileLink({
  href,
  children,
  basePath,
}: {
  href?: string
  children: ReactNode
  basePath?: string
}) {
  const openFile = useContext(WorkspaceFileLinkContext)
  const file = href ? parseWorkspaceFileLink(href, basePath) : null
  if (file) {
    return (
      <button
        type="button"
        className="inline cursor-pointer break-words text-left text-blue-300 underline decoration-blue-300/40 underline-offset-4 focus-visible:outline focus-visible:outline-blue-400"
        disabled={!openFile}
        title={`Preview ${file.path}${file.line ? `:${file.line}` : ''}`}
        onClick={() => openFile?.(file)}
      >
        {children}
      </button>
    )
  }
  // A malformed local target must never become a request to the desktop website.
  if (!href || !/^(https?:|mailto:)/i.test(href)) return <span>{children}</span>
  return (
    <a href={href} rel="noreferrer noopener" target="_blank">
      {children}
    </a>
  )
}

export function WorkspaceImage({ src, alt, basePath }: { src?: string; alt?: string; basePath?: string }) {
  const agentId = useContext(WorkspaceAgentContext)
  const file = src ? parseWorkspaceFileLink(src, basePath) : null
  const [failedSource, setFailedSource] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  if (!agentId || !file || !isWorkspaceImagePath(file.path)) return <span>[Image{alt ? `: ${alt}` : ''}]</span>
  const query = new URLSearchParams({ agentId, path: file.path })
  if (attempt) query.set('attempt', String(attempt))
  const url = `/api/tengri/attachments?${query}`
  if (failedSource === url)
    return (
      <span role="status">
        Image unavailable{alt ? `: ${alt}` : ''}{' '}
        <button
          type="button"
          className="text-blue-300 underline underline-offset-4 focus-visible:outline focus-visible:outline-blue-400"
          onClick={() => {
            setFailedSource(null)
            setAttempt((value) => value + 1)
          }}
        >
          Retry image
        </button>
      </span>
    )
  return (
    <img
      src={url}
      alt={alt || file.path.split('/').at(-1) || 'Agent image'}
      loading="lazy"
      referrerPolicy="no-referrer"
      className="my-2 max-h-[32rem] max-w-full rounded-lg object-contain"
      onError={() => setFailedSource(url)}
    />
  )
}
