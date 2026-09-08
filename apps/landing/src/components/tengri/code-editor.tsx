'use client'

import { Check, CircleAlert, FileCode2, LoaderCircle, X } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

import type { TengriFileEvent } from '@/lib/tengri/types'
import { MAX_CODE_WATCH_DIRECTORIES } from '@/lib/tengri/limits'

import { runTengriAction, TengriRequestError } from './client'
import { CodeWriteEchoTracker } from './code-write-echo'
import {
  createBrowserCodeDraftStore,
  createCodeDraft,
  forgetCodeDraft,
  isCodeRevision,
  markCodeDraftDurable,
  markCodeDraftVolatile,
  parseCodeRevision,
  rememberCodeDraft,
  rememberedCodeDraft,
  mergeCodeDraftContent,
  type CodeBaseRevision,
  type CodeDraft,
  type CodeDraftIdentity,
  type CodeRevision,
  type CodeDraftStore,
} from './code-editor-draft-storage'
import {
  canStartEditorSave,
  clearCodeWatchDirectoryLimitError,
  closeEditorTab,
  codeFileName,
  codeLanguage,
  codeModelKey,
  codeModelTransition,
  codeOpenRequestKey,
  codePanelId,
  codeParentDirectory,
  codeVerificationFailure,
  codeWatchDirectoryLimitError,
  disposeCodeModels,
  enqueueCodeOpenRequest,
  isEditorValuePersisted,
  isCodePath,
  openEditorTab,
  renameEditorTab,
  type CodeOpenRequest,
  type EditorTab,
} from './code-editor-model'
import { ConfirmationDialog } from './confirmation-dialog'

type Monaco = typeof import('monaco-editor')
type Editor = import('monaco-editor').editor.IStandaloneCodeEditor
type TextModel = import('monaco-editor').editor.ITextModel

type MonacoGlobal = typeof globalThis & {
  MonacoEnvironment?: {
    getWorker: (_workerModuleId: string, label: string) => Worker
  }
}

type CodeFileSnapshot = {
  content: string
  contentType: string
  revision: CodeBaseRevision
}

type RevisionedCodeFileSnapshot = CodeFileSnapshot

type DraftPrompt =
  | { kind: 'recoverable'; path: string; draft: CodeDraft; server: RevisionedCodeFileSnapshot }
  | { kind: 'conflict'; path: string; draft: CodeDraft; server: RevisionedCodeFileSnapshot }

const LEGACY_REVISION_MESSAGE =
  'This guest does not report file revisions. Code is read-only until the guest resumes with revision-aware filesystem state.'
const CODE_CONTENT_TYPE_FALLBACK = 'text/plain'

function configureMonacoWorkers() {
  const environment = globalThis as MonacoGlobal
  if (environment.MonacoEnvironment?.getWorker) return
  environment.MonacoEnvironment = {
    getWorker: (_workerModuleId, label) => {
      if (label === 'json') {
        return new Worker(new URL('monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url), {
          name: 'tengri-monaco-json',
          type: 'module',
        })
      }
      if (label === 'css' || label === 'less' || label === 'scss') {
        return new Worker(new URL('monaco-editor/esm/vs/language/css/css.worker.js', import.meta.url), {
          name: 'tengri-monaco-css',
          type: 'module',
        })
      }
      if (label === 'handlebars' || label === 'html' || label === 'razor') {
        return new Worker(new URL('monaco-editor/esm/vs/language/html/html.worker.js', import.meta.url), {
          name: 'tengri-monaco-html',
          type: 'module',
        })
      }
      if (label === 'javascript' || label === 'typescript') {
        return new Worker(new URL('monaco-editor/esm/vs/language/typescript/ts.worker.js', import.meta.url), {
          name: 'tengri-monaco-typescript',
          type: 'module',
        })
      }
      return new Worker(new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url), {
        name: 'tengri-monaco-editor',
        type: 'module',
      })
    },
  }
}

export function CodeEditor({
  agentId,
  agentCreatedAt,
  onDirtyChange,
  ownerId,
  request,
}: {
  agentId: string
  agentCreatedAt: string
  onDirtyChange?: (dirty: boolean) => void
  ownerId: string
  request: CodeOpenRequest | null
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<Editor | null>(null)
  const monacoRef = useRef<Monaco | null>(null)
  const editorInstanceId = useId().replaceAll(/[^a-zA-Z0-9_-]/g, '')
  const activePathRef = useRef('')
  const tabsRef = useRef<EditorTab[]>([])
  const modelsRef = useRef(new Map<string, TextModel>())
  const requestsRef = useRef(new Map<string, AbortController>())
  const pendingRequestsRef = useRef<CodeOpenRequest[]>([])
  const processedRequestsRef = useRef(new Set<string>())
  const agentIdRef = useRef(agentId)
  const agentCreatedAtRef = useRef(agentCreatedAt)
  const ownerIdRef = useRef(ownerId)
  const conflictReadGenerationsRef = useRef(new Map<string, number>())
  const reloadGenerationsRef = useRef(new Map<string, number>())
  const loadingPathsRef = useRef(new Set<string>())
  const saveTimersRef = useRef(new Map<string, number>())
  const saveQueuesRef = useRef(new Map<string, Promise<boolean>>())
  const lastSavedRef = useRef(new Map<string, string>())
  const baseRevisionsRef = useRef(new Map<string, CodeBaseRevision>())
  const contentTypesRef = useRef(new Map<string, string>())
  const draftStoreRef = useRef<CodeDraftStore | null>(null)
  const draftIdsRef = useRef(new Map<string, string>())
  const sourceDraftIdsRef = useRef(new Map<string, string>())
  const sourceDraftsRef = useRef(new Map<string, CodeDraft>())
  const pendingDraftsRef = useRef(new Map<string, CodeDraft>())
  const draftPromptsRef = useRef(new Map<string, DraftPrompt>())
  const conflictSnapshotsRef = useRef(new Map<string, CodeFileSnapshot>())
  const readOnlyPathsRef = useRef(new Set<string>())
  const writeEchoesRef = useRef(new CodeWriteEchoTracker())
  const conflictedPathsRef = useRef(new Set<string>())
  const unverifiedPathsRef = useRef(new Set<string>())
  const migratingPathsRef = useRef(new Set<string>())
  const writeControllersRef = useRef(new Map<string, AbortController>())
  const watchCursorsRef = useRef(new Map<string, number>())
  const recentWriteTimersRef = useRef(new Map<string, Map<string, number>>())
  const pendingRenameTimersRef = useRef(new Map<string, number>())
  const onDirtyChangeRef = useRef(onDirtyChange)
  const disposedRef = useRef(false)
  const [ownerAgentId, setOwnerAgentId] = useState(agentId)
  const [tabs, setTabs] = useState<EditorTab[]>([])
  const [activePath, setActivePath] = useState('')
  const [cursor, setCursor] = useState({ line: 1, column: 1 })
  const [editorReady, setEditorReady] = useState(false)
  const [editorError, setEditorError] = useState('')
  const [draftError, setDraftError] = useState('')
  const [, setDraftPromptVersion] = useState(0)
  const [readOnlyPaths, setReadOnlyPaths] = useState<Set<string>>(() => new Set())
  const [ownerWarning, setOwnerWarning] = useState('')
  const [watchState, setWatchState] = useState<'connected' | 'reconnecting'>('connected')
  const [pendingClose, setPendingClose] = useState<EditorTab | null>(null)
  const [closeBusy, setCloseBusy] = useState(false)
  const [closeError, setCloseError] = useState('')
  const watchDirectoryKey = useMemo(
    () => [...new Set(tabs.map((tab) => codeParentDirectory(tab.path)))].sort().join('\0'),
    [tabs],
  )

  if (!draftStoreRef.current) draftStoreRef.current = createBrowserCodeDraftStore()

  const updateTabs = useCallback((update: (current: EditorTab[]) => EditorTab[]) => {
    setTabs((current) => {
      const next = update(current)
      tabsRef.current = next
      return next
    })
  }, [])

  const patchTab = useCallback(
    (targetPath: string, patch: Partial<EditorTab>) => {
      updateTabs((current) =>
        current.map((tab) => (tab.path === targetPath ? { ...tab, ...patch, path: tab.path } : tab)),
      )
    },
    [updateTabs],
  )

  const draftIdentity = useCallback(
    (targetPath: string): CodeDraftIdentity => ({
      agentCreatedAt: agentCreatedAtRef.current,
      agentId: agentIdRef.current,
      ownerId: ownerIdRef.current,
      path: targetPath,
    }),
    [],
  )

  const findAvailableDraft = useCallback(
    (targetPath: string): CodeDraft | undefined => {
      const storedDraft = draftStoreRef.current?.read(draftIdentity(targetPath))
      if (storedDraft?.kind === 'unavailable') setDraftError(storedDraft.message)
      const durableDraft = storedDraft?.kind === 'found' ? storedDraft.draft : undefined
      const memoryDraft = rememberedCodeDraft(draftIdentity(targetPath))
      return [durableDraft, memoryDraft]
        .filter((draft): draft is CodeDraft => draft !== undefined)
        .sort((left, right) => right.updatedAt - left.updatedAt)[0]
    },
    [draftIdentity],
  )

  const persistDraft = useCallback(
    (targetPath: string, content: string, baseRevision = baseRevisionsRef.current.get(targetPath)) => {
      if (baseRevision === undefined || readOnlyPathsRef.current.has(targetPath)) return false
      const draftId = draftIdsRef.current.get(targetPath)
      const draft = createCodeDraft(
        draftIdentity(targetPath),
        content,
        baseRevision,
        contentTypesRef.current.get(targetPath) ?? CODE_CONTENT_TYPE_FALLBACK,
        Date.now(),
        draftId,
      )
      draftIdsRef.current.set(targetPath, draft.draftId)
      pendingDraftsRef.current.set(targetPath, draft)
      const remembered = rememberCodeDraft(draft)
      if (!remembered) {
        setDraftError('Code kept this draft in the open editor but could not retain another in-memory recovery copy.')
      }
      const result = draftStoreRef.current?.write(draft)
      if (result?.kind === 'stored') {
        markCodeDraftDurable(draft)
        setDraftError((current) => (current.startsWith('Browser storage is unavailable') ? '' : current))
        return true
      }
      if (markCodeDraftVolatile(draft)) {
        setDraftError(
          result?.message ??
            'Browser storage is unavailable, so Code could not save this draft for recovery. Keep this tab open while storage is unavailable.',
        )
      } else if (!remembered) {
        setDraftError('Code could not retain another recovery copy. Download this draft before closing the editor.')
      } else {
        setDraftError(
          result?.message ??
            'Browser storage is unavailable, so Code could not save this draft for recovery. Keep this tab open while storage is unavailable.',
        )
      }
      return false
    },
    [draftIdentity],
  )

  const removeDraft = useCallback(
    (targetPath: string) => {
      const draftId = draftIdsRef.current.get(targetPath)
      if (!draftId) {
        pendingDraftsRef.current.delete(targetPath)
        return true
      }
      const result = draftStoreRef.current?.remove(draftIdentity(targetPath), draftId)
      if (!result || result.kind === 'removed' || result.kind === 'missing') {
        pendingDraftsRef.current.delete(targetPath)
        forgetCodeDraft(draftIdentity(targetPath), draftId)
        setDraftError((current) =>
          current.startsWith('Browser storage is unavailable') ||
          current.startsWith('Code recovery storage is full') ||
          current.startsWith('The edited draft is too large')
            ? ''
            : current,
        )
        return true
      }
      setDraftError(result.message)
      return false
    },
    [draftIdentity],
  )

  const removeDraftById = useCallback(
    (targetPath: string, draftId: string) => {
      const result = draftStoreRef.current?.remove(draftIdentity(targetPath), draftId)
      if (!result || result.kind === 'removed' || result.kind === 'missing') {
        if (draftIdsRef.current.get(targetPath) === draftId) pendingDraftsRef.current.delete(targetPath)
        forgetCodeDraft(draftIdentity(targetPath), draftId)
        return true
      }
      setDraftError(result.message)
      return false
    },
    [draftIdentity],
  )

  const setReadOnlyPath = useCallback((targetPath: string, readOnly: boolean) => {
    const current = readOnlyPathsRef.current.has(targetPath)
    if (current === readOnly) return
    if (readOnly) readOnlyPathsRef.current.add(targetPath)
    else readOnlyPathsRef.current.delete(targetPath)
    setReadOnlyPaths(new Set(readOnlyPathsRef.current))
    if (activePathRef.current === targetPath) editorRef.current?.updateOptions({ readOnly })
  }, [])

  const setDraftPrompt = useCallback((prompt: DraftPrompt | null, targetPath: string) => {
    if (prompt) draftPromptsRef.current.set(targetPath, prompt)
    else draftPromptsRef.current.delete(targetPath)
    setDraftPromptVersion((version) => version + 1)
  }, [])

  const markConflict = useCallback(
    (targetPath: string, error: string) => {
      unverifiedPathsRef.current.delete(targetPath)
      conflictedPathsRef.current.add(targetPath)
      const model = modelsRef.current.get(codeModelKey(ownerAgentId, targetPath))
      if (model) persistDraft(targetPath, model.getValue())
      writeControllersRef.current.get(targetPath)?.abort()
      const timer = saveTimersRef.current.get(targetPath)
      if (timer) window.clearTimeout(timer)
      saveTimersRef.current.delete(targetPath)
      patchTab(targetPath, { dirty: true, state: 'error', error })
      setDraftPromptVersion((version) => version + 1)
    },
    [ownerAgentId, patchTab, persistDraft],
  )

  const markUnverified = useCallback(
    (targetPath: string, error: string) => {
      conflictedPathsRef.current.delete(targetPath)
      unverifiedPathsRef.current.add(targetPath)
      writeControllersRef.current.get(targetPath)?.abort()
      const timer = saveTimersRef.current.get(targetPath)
      if (timer) window.clearTimeout(timer)
      saveTimersRef.current.delete(targetPath)
      patchTab(targetPath, { state: 'error', error })
    },
    [patchTab],
  )

  const clearPendingRename = useCallback((targetPath: string) => {
    const timer = pendingRenameTimersRef.current.get(targetPath)
    if (timer) window.clearTimeout(timer)
    return pendingRenameTimersRef.current.delete(targetPath)
  }, [])

  const deferUnpairedRename = useCallback(
    (targetPath: string) => {
      if (pendingRenameTimersRef.current.has(targetPath)) return
      conflictedPathsRef.current.add(targetPath)
      patchTab(targetPath, { state: 'loading', error: '' })
      const timer = window.setTimeout(() => {
        pendingRenameTimersRef.current.delete(targetPath)
        const current = tabsRef.current.find((tab) => tab.path === targetPath)
        if (!current) return
        patchTab(targetPath, {
          dirty: current.dirty,
          state: 'error',
          error: 'File was renamed outside Code. Reopen it from Finder before saving.',
        })
      }, 250)
      pendingRenameTimersRef.current.set(targetPath, timer)
    },
    [patchTab],
  )

  const refreshConflictSnapshot = useCallback(
    async (targetPath: string, localContent: string, baseRevision: CodeBaseRevision) => {
      if (disposedRef.current) return
      const generation = (conflictReadGenerationsRef.current.get(targetPath) ?? 0) + 1
      conflictReadGenerationsRef.current.set(targetPath, generation)
      const requestAgentId = ownerAgentId
      const requestOwnerId = ownerIdRef.current
      const requestAgentCreatedAt = agentCreatedAtRef.current
      const isCurrent = () =>
        !disposedRef.current &&
        conflictReadGenerationsRef.current.get(targetPath) === generation &&
        agentIdRef.current === requestAgentId &&
        ownerIdRef.current === requestOwnerId &&
        agentCreatedAtRef.current === requestAgentCreatedAt
      try {
        const raw = await runTengriAction<unknown>({ action: 'read-file', agentId: requestAgentId, path: targetPath })
        if (!isCurrent()) return
        const decoded = decodeCodeFileSnapshot(raw)
        if (!decoded || decoded.kind === 'legacy') {
          setReadOnlyPath(targetPath, true)
          markConflict(targetPath, LEGACY_REVISION_MESSAGE)
          return
        }
        const snapshot = decoded.snapshot
        conflictSnapshotsRef.current.set(targetPath, snapshot)
        contentTypesRef.current.set(targetPath, snapshot.contentType)
        setDraftPrompt(null, targetPath)
        const currentModel = modelsRef.current.get(codeModelKey(requestAgentId, targetPath))
        persistDraft(targetPath, currentModel?.getValue() ?? localContent, baseRevision)
        markConflict(targetPath, 'File changed on the guest before this save. Review it before retrying.')
      } catch (cause) {
        if (!isCurrent()) return
        const currentModel = modelsRef.current.get(codeModelKey(requestAgentId, targetPath))
        persistDraft(targetPath, currentModel?.getValue() ?? localContent, baseRevision)
        markConflict(
          targetPath,
          cause instanceof Error
            ? `The save found a newer guest file, but Code could not reload it: ${cause.message}`
            : 'The save found a newer guest file, but Code could not reload it. Retry to review the conflict.',
        )
      }
    },
    [markConflict, ownerAgentId, persistDraft, setDraftPrompt, setReadOnlyPath],
  )

  const savePath = useCallback(
    (targetPath: string, content: string, versionId: number) => {
      const expectedRevision = baseRevisionsRef.current.get(targetPath)
      if (expectedRevision === undefined || readOnlyPathsRef.current.has(targetPath)) {
        patchTab(targetPath, { dirty: true, state: 'error', error: LEGACY_REVISION_MESSAGE })
        setReadOnlyPath(targetPath, true)
        return Promise.resolve(false)
      }
      persistDraft(targetPath, content, expectedRevision)
      writeEchoesRef.current.begin(targetPath, content)
      patchTab(targetPath, { dirty: true, state: 'saving', error: '' })
      const previous = saveQueuesRef.current.get(targetPath) ?? Promise.resolve(true)
      const operation = previous.then(async () => {
        if (disposedRef.current) return false
        if (
          !canStartEditorSave(
            targetPath,
            conflictedPathsRef.current,
            unverifiedPathsRef.current,
            migratingPathsRef.current,
          )
        )
          return false
        const currentExpectedRevision = baseRevisionsRef.current.get(targetPath)
        if (currentExpectedRevision === undefined || readOnlyPathsRef.current.has(targetPath)) {
          patchTab(targetPath, { dirty: true, state: 'error', error: LEGACY_REVISION_MESSAGE })
          setReadOnlyPath(targetPath, true)
          return false
        }
        const controller = new AbortController()
        writeControllersRef.current.set(targetPath, controller)
        try {
          const raw = await runTengriAction<unknown>(
            {
              action: 'write-file',
              agentId: ownerAgentId,
              path: targetPath,
              content,
              expectedRevision: currentExpectedRevision,
            },
            controller.signal,
          )
          const result = decodeCodeWriteResult(raw)
          if (!result || result.path !== targetPath) throw new Error('Tengri returned an invalid save receipt.')
          baseRevisionsRef.current.set(targetPath, result.revision)
          lastSavedRef.current.set(targetPath, content)
          const model = modelsRef.current.get(codeModelKey(ownerAgentId, targetPath))
          const unchanged = model?.getVersionId() === versionId && model.getValue() === content
          if (disposedRef.current) {
            if (unchanged) {
              removeDraft(targetPath)
              const sourceDraftId = sourceDraftIdsRef.current.get(targetPath)
              if (sourceDraftId && sourceDraftId !== draftIdsRef.current.get(targetPath)) {
                removeDraftById(targetPath, sourceDraftId)
              }
              sourceDraftIdsRef.current.delete(targetPath)
              sourceDraftsRef.current.delete(targetPath)
            } else persistDraft(targetPath, model?.getValue() ?? content, result.revision)
            return true
          }
          const timers = recentWriteTimersRef.current.get(targetPath) ?? new Map<string, number>()
          for (const previousTimer of timers.values()) window.clearTimeout(previousTimer)
          timers.clear()
          writeEchoesRef.current.remember(targetPath, content)
          const timer = window.setTimeout(() => {
            writeEchoesRef.current.forget(targetPath, content)
            const current = recentWriteTimersRef.current.get(targetPath)
            if (current?.get(content) !== timer) return
            current.delete(content)
            if (!current.size) recentWriteTimersRef.current.delete(targetPath)
          }, 5_000)
          timers.set(content, timer)
          recentWriteTimersRef.current.set(targetPath, timers)
          if (unchanged) {
            removeDraft(targetPath)
            const sourceDraftId = sourceDraftIdsRef.current.get(targetPath)
            if (sourceDraftId && sourceDraftId !== draftIdsRef.current.get(targetPath)) {
              removeDraftById(targetPath, sourceDraftId)
            }
            sourceDraftIdsRef.current.delete(targetPath)
            sourceDraftsRef.current.delete(targetPath)
          } else persistDraft(targetPath, model?.getValue() ?? content, result.revision)
          patchTab(targetPath, {
            dirty: !unchanged,
            state: unchanged ? 'ready' : 'saving',
            error: '',
          })
          return true
        } catch (cause) {
          if (cause instanceof TengriRequestError && cause.status === 409) {
            if (!disposedRef.current) {
              const currentModel = modelsRef.current.get(codeModelKey(ownerAgentId, targetPath))
              await refreshConflictSnapshot(targetPath, currentModel?.getValue() ?? content, currentExpectedRevision)
            }
            return false
          }
          if (
            !disposedRef.current &&
            !conflictedPathsRef.current.has(targetPath) &&
            !migratingPathsRef.current.has(targetPath)
          ) {
            patchTab(targetPath, {
              dirty: true,
              state: 'error',
              error: cause instanceof Error ? cause.message : 'Save failed',
            })
          }
          return false
        } finally {
          if (writeControllersRef.current.get(targetPath) === controller) writeControllersRef.current.delete(targetPath)
        }
      })
      const tracked = operation.finally(() => {
        writeEchoesRef.current.finish(targetPath, content)
        if (saveQueuesRef.current.get(targetPath) !== tracked) return
        saveQueuesRef.current.delete(targetPath)
      })
      saveQueuesRef.current.set(targetPath, tracked)
      return tracked
    },
    [ownerAgentId, patchTab, persistDraft, refreshConflictSnapshot, removeDraft, removeDraftById, setReadOnlyPath],
  )

  const scheduleSave = useCallback(
    (targetPath: string, model: TextModel) => {
      const currentTimer = saveTimersRef.current.get(targetPath)
      if (currentTimer) window.clearTimeout(currentTimer)
      if (
        !canStartEditorSave(
          targetPath,
          conflictedPathsRef.current,
          unverifiedPathsRef.current,
          migratingPathsRef.current,
        )
      ) {
        patchTab(targetPath, { dirty: true })
        return
      }
      patchTab(targetPath, { dirty: true, state: 'saving', error: '' })
      saveTimersRef.current.set(
        targetPath,
        window.setTimeout(() => {
          saveTimersRef.current.delete(targetPath)
          void savePath(targetPath, model.getValue(), model.getVersionId())
        }, 650),
      )
    },
    [patchTab, savePath],
  )

  const flushPath = useCallback(
    async (targetPath: string) => {
      const model = modelsRef.current.get(codeModelKey(ownerAgentId, targetPath))
      if (!model) return false
      if (readOnlyPathsRef.current.has(targetPath)) return false
      if (unverifiedPathsRef.current.has(targetPath)) {
        await reloadPathRef.current(targetPath)
        const refreshed = tabsRef.current.find((tab) => tab.path === targetPath)
        return (
          !unverifiedPathsRef.current.has(targetPath) &&
          !conflictedPathsRef.current.has(targetPath) &&
          refreshed?.state === 'ready' &&
          !refreshed.dirty
        )
      }
      const resolvingConflict = conflictedPathsRef.current.has(targetPath)
      if (resolvingConflict) {
        const snapshot = conflictSnapshotsRef.current.get(targetPath)
        if (!snapshot) return false
        baseRevisionsRef.current.set(targetPath, snapshot.revision)
        contentTypesRef.current.set(targetPath, snapshot.contentType)
        conflictSnapshotsRef.current.delete(targetPath)
        conflictedPathsRef.current.delete(targetPath)
        setDraftPrompt(null, targetPath)
        persistDraft(targetPath, model.getValue(), snapshot.revision)
        return savePath(targetPath, model.getValue(), model.getVersionId())
      }
      conflictedPathsRef.current.delete(targetPath)
      let timer = saveTimersRef.current.get(targetPath)
      if (timer) window.clearTimeout(timer)
      saveTimersRef.current.delete(targetPath)
      const queued = saveQueuesRef.current.get(targetPath)
      if (queued) await queued
      if (disposedRef.current || model.isDisposed()) return false
      timer = saveTimersRef.current.get(targetPath)
      if (timer) window.clearTimeout(timer)
      saveTimersRef.current.delete(targetPath)
      if (!resolvingConflict && isEditorValuePersisted(model.getValue(), lastSavedRef.current.get(targetPath), false)) {
        patchTab(targetPath, { dirty: false, state: 'ready', error: '' })
        return true
      }
      return savePath(targetPath, model.getValue(), model.getVersionId())
    },
    [ownerAgentId, patchTab, persistDraft, savePath, setDraftPrompt],
  )

  const flushActive = useCallback(() => {
    const targetPath = activePathRef.current
    if (targetPath) void flushPath(targetPath)
  }, [flushPath])

  const flushActiveRef = useRef(flushActive)
  const reloadPathRef = useRef<(targetPath: string) => Promise<void>>(async () => {})
  const patchTabRef = useRef(patchTab)
  const scheduleSaveRef = useRef(scheduleSave)
  const persistDraftRef = useRef(persistDraft)
  const removeDraftRef = useRef(removeDraft)
  const setDraftPromptRef = useRef(setDraftPrompt)
  flushActiveRef.current = flushActive
  patchTabRef.current = patchTab
  scheduleSaveRef.current = scheduleSave
  persistDraftRef.current = persistDraft
  removeDraftRef.current = removeDraft
  setDraftPromptRef.current = setDraftPrompt

  const showPath = useCallback(
    (targetPath: string, refresh = false) => {
      const editor = editorRef.current
      if (!editor) return false
      const transition = codeModelTransition(
        activePathRef.current,
        targetPath,
        modelsRef.current.get(codeModelKey(ownerAgentId, targetPath)),
        refresh,
      )
      if (transition.type === 'detach') editor.setModel(null)
      if (transition.type !== 'show' && transition.type !== 'refresh') return false
      activePathRef.current = targetPath
      setActivePath(targetPath)
      editor.setModel(transition.model)
      editor.updateOptions({ readOnly: readOnlyPathsRef.current.has(targetPath) })
      return transition.type === 'show'
    },
    [ownerAgentId],
  )

  const loadPath = useCallback(
    async (targetPath: string, refresh = false) => {
      const monaco = monacoRef.current
      const editor = editorRef.current
      if (!monaco || !editor || !isCodePath(targetPath)) return
      if (showPath(targetPath, refresh)) {
        patchTab(targetPath, {
          state: 'ready',
          error: readOnlyPathsRef.current.has(targetPath) ? LEGACY_REVISION_MESSAGE : '',
        })
        return
      }
      if (refresh && tabsRef.current.find((tab) => tab.path === targetPath)?.dirty) {
        markConflict(targetPath, 'File changed outside Code while local edits were pending.')
        return
      }

      const modelKey = codeModelKey(ownerAgentId, targetPath)
      const cachedModel = modelsRef.current.get(modelKey)
      const initialVersionId = cachedModel?.getVersionId()
      requestsRef.current.get(modelKey)?.abort()
      const controller = new AbortController()
      requestsRef.current.set(modelKey, controller)
      patchTab(targetPath, { state: 'loading', error: '' })
      try {
        const raw = await runTengriAction<unknown>(
          { action: 'read-file', agentId: ownerAgentId, path: targetPath },
          controller.signal,
        )
        const decoded = decodeCodeFileSnapshot(raw)
        if (!decoded) throw new Error('Tengri returned an invalid file revision receipt.')
        if (
          disposedRef.current ||
          controller.signal.aborted ||
          agentIdRef.current !== ownerAgentId ||
          ownerIdRef.current !== ownerId ||
          agentCreatedAtRef.current !== agentCreatedAt
        )
          return
        const currentModel = modelsRef.current.get(modelKey)
        const currentTab = tabsRef.current.find((tab) => tab.path === targetPath)
        if (
          refresh &&
          (currentTab?.dirty || (initialVersionId !== undefined && currentModel?.getVersionId() !== initialVersionId))
        ) {
          if (decoded.kind === 'revisioned') conflictSnapshotsRef.current.set(targetPath, decoded.snapshot)
          markConflict(
            targetPath,
            decoded.kind === 'legacy'
              ? LEGACY_REVISION_MESSAGE
              : 'File changed outside Code while local edits were pending.',
          )
          if (decoded.kind === 'legacy') setReadOnlyPath(targetPath, true)
          return
        }
        if (decoded.kind === 'legacy') {
          const uri = monaco.Uri.from({
            scheme: 'tengri',
            authority: 'code',
            path: targetPath,
            query: `agent=${encodeURIComponent(ownerAgentId)}&editor=${editorInstanceId}`,
          })
          let legacyModel = cachedModel
          if (!legacyModel || legacyModel.isDisposed())
            legacyModel = monaco.editor.createModel(decoded.snapshot.content, codeLanguage(targetPath), uri)
          else if (legacyModel.getValue() !== decoded.snapshot.content) {
            loadingPathsRef.current.add(modelKey)
            try {
              legacyModel.setValue(decoded.snapshot.content)
            } finally {
              loadingPathsRef.current.delete(modelKey)
            }
          }
          modelsRef.current.set(modelKey, legacyModel)
          baseRevisionsRef.current.delete(targetPath)
          contentTypesRef.current.set(targetPath, decoded.snapshot.contentType)
          lastSavedRef.current.set(targetPath, decoded.snapshot.content)
          conflictedPathsRef.current.delete(targetPath)
          unverifiedPathsRef.current.delete(targetPath)
          conflictSnapshotsRef.current.delete(targetPath)
          sourceDraftIdsRef.current.delete(targetPath)
          sourceDraftsRef.current.delete(targetPath)
          pendingDraftsRef.current.delete(targetPath)
          const legacyDraft = findAvailableDraft(targetPath)
          if (legacyDraft) {
            sourceDraftIdsRef.current.set(targetPath, legacyDraft.draftId)
            sourceDraftsRef.current.set(targetPath, legacyDraft)
            pendingDraftsRef.current.set(targetPath, legacyDraft)
            setDraftError(
              (current) =>
                current ||
                'A local draft is preserved, but it cannot be safely recovered until the guest reports revisions. Download it before closing this tab.',
            )
          }
          setDraftPrompt(null, targetPath)
          setReadOnlyPath(targetPath, true)
          patchTab(targetPath, { dirty: false, state: 'ready', error: LEGACY_REVISION_MESSAGE })
          if (activePathRef.current === targetPath) {
            editor.setModel(legacyModel)
            editor.updateOptions({ readOnly: true })
          }
          return
        }
        const result = decoded.snapshot
        const uri = monaco.Uri.from({
          scheme: 'tengri',
          authority: 'code',
          path: targetPath,
          query: `agent=${encodeURIComponent(ownerAgentId)}&editor=${editorInstanceId}`,
        })
        let model = cachedModel
        if (!model || model.isDisposed())
          model = monaco.editor.createModel(result.content, codeLanguage(targetPath), uri)
        else if (model.getValue() !== result.content) {
          loadingPathsRef.current.add(modelKey)
          try {
            model.setValue(result.content)
          } finally {
            loadingPathsRef.current.delete(modelKey)
          }
        }
        modelsRef.current.set(modelKey, model)
        baseRevisionsRef.current.set(targetPath, result.revision)
        contentTypesRef.current.set(targetPath, result.contentType)
        lastSavedRef.current.set(targetPath, result.content)
        conflictedPathsRef.current.delete(targetPath)
        unverifiedPathsRef.current.delete(targetPath)
        conflictSnapshotsRef.current.delete(targetPath)
        setReadOnlyPath(targetPath, false)
        sourceDraftIdsRef.current.delete(targetPath)
        sourceDraftsRef.current.delete(targetPath)
        pendingDraftsRef.current.delete(targetPath)
        const availableDraft = findAvailableDraft(targetPath)
        if (availableDraft) {
          sourceDraftIdsRef.current.set(targetPath, availableDraft.draftId)
          sourceDraftsRef.current.set(targetPath, availableDraft)
          pendingDraftsRef.current.set(targetPath, availableDraft)
          if (availableDraft.content === result.content && availableDraft.baseRevision === result.revision) {
            removeDraftById(targetPath, availableDraft.draftId)
            sourceDraftIdsRef.current.delete(targetPath)
            sourceDraftsRef.current.delete(targetPath)
            setDraftPrompt(null, targetPath)
          } else {
            setDraftPrompt(
              {
                kind: availableDraft.baseRevision === result.revision ? 'recoverable' : 'conflict',
                path: targetPath,
                draft: availableDraft,
                server: { content: result.content, contentType: result.contentType, revision: result.revision },
              },
              targetPath,
            )
          }
        } else {
          setDraftPrompt(null, targetPath)
        }
        patchTab(targetPath, { dirty: false, state: 'ready', error: '' })
        if (activePathRef.current === targetPath) {
          editor.setModel(model)
          editor.updateOptions({ readOnly: false })
        }
      } catch (cause) {
        if (
          controller.signal.aborted ||
          agentIdRef.current !== ownerAgentId ||
          ownerIdRef.current !== ownerId ||
          agentCreatedAtRef.current !== agentCreatedAt
        )
          return
        if (cause instanceof TengriRequestError && cause.status === 404) {
          const missingDraft = findAvailableDraft(targetPath)
          if (missingDraft) {
            sourceDraftIdsRef.current.set(targetPath, missingDraft.draftId)
            sourceDraftsRef.current.set(targetPath, missingDraft)
            pendingDraftsRef.current.set(targetPath, missingDraft)
            setDraftError(
              'The guest file no longer exists, but Code preserved your local draft. Download it before closing this tab.',
            )
          }
        }
        patchTab(targetPath, {
          state: 'error',
          error: cause instanceof Error ? cause.message : 'File could not be opened',
        })
      } finally {
        if (requestsRef.current.get(modelKey) === controller) requestsRef.current.delete(modelKey)
      }
    },
    [
      agentCreatedAt,
      draftIdentity,
      editorInstanceId,
      findAvailableDraft,
      markConflict,
      ownerAgentId,
      ownerId,
      patchTab,
      removeDraft,
      removeDraftById,
      setDraftPrompt,
      setReadOnlyPath,
      showPath,
    ],
  )

  const applyDraftContent = useCallback(
    (targetPath: string, content: string, baseRevision: CodeBaseRevision, saveAfter: boolean) => {
      const model = modelsRef.current.get(codeModelKey(ownerAgentId, targetPath))
      if (!model || model.isDisposed()) return false
      loadingPathsRef.current.add(codeModelKey(ownerAgentId, targetPath))
      try {
        model.setValue(content)
      } finally {
        loadingPathsRef.current.delete(codeModelKey(ownerAgentId, targetPath))
      }
      baseRevisionsRef.current.set(targetPath, baseRevision)
      contentTypesRef.current.set(targetPath, contentTypesRef.current.get(targetPath) ?? CODE_CONTENT_TYPE_FALLBACK)
      setReadOnlyPath(targetPath, false)
      persistDraft(targetPath, content, baseRevision)
      patchTab(targetPath, {
        dirty: true,
        state: saveAfter ? 'saving' : 'error',
        error: saveAfter ? '' : 'Local draft is based on an older guest file. Review it before saving.',
      })
      if (saveAfter) scheduleSaveRef.current(targetPath, model)
      return true
    },
    [ownerAgentId, patchTab, persistDraft, setReadOnlyPath],
  )

  const recoverDraft = useCallback(
    (targetPath: string) => {
      const prompt = draftPromptsRef.current.get(targetPath)
      if (!prompt) return
      conflictSnapshotsRef.current.delete(targetPath)
      conflictedPathsRef.current.delete(targetPath)
      unverifiedPathsRef.current.delete(targetPath)
      if (applyDraftContent(targetPath, prompt.draft.content, prompt.server.revision, true)) {
        setDraftPrompt(null, targetPath)
      }
    },
    [applyDraftContent, setDraftPrompt],
  )

  const keepConflictingDraft = useCallback(
    (targetPath: string) => {
      const prompt = draftPromptsRef.current.get(targetPath)
      if (!prompt || prompt.kind !== 'conflict') return
      conflictSnapshotsRef.current.set(targetPath, prompt.server)
      conflictedPathsRef.current.add(targetPath)
      if (applyDraftContent(targetPath, prompt.draft.content, prompt.server.revision, false)) {
        setDraftPrompt(null, targetPath)
      }
    },
    [applyDraftContent, setDraftPrompt],
  )

  const mergeConflictingDraft = useCallback(
    (targetPath: string) => {
      const prompt = draftPromptsRef.current.get(targetPath)
      if (!prompt || prompt.kind !== 'conflict') return
      conflictSnapshotsRef.current.delete(targetPath)
      conflictedPathsRef.current.delete(targetPath)
      const merged = mergeCodeDraftContent(prompt.server.content, prompt.draft.content)
      if (applyDraftContent(targetPath, merged, prompt.server.revision, true)) {
        setDraftPrompt(null, targetPath)
      }
    },
    [applyDraftContent, setDraftPrompt],
  )

  const reloadDraftServer = useCallback(
    async (targetPath: string) => {
      const model = modelsRef.current.get(codeModelKey(ownerAgentId, targetPath))
      if (!model || model.isDisposed()) return
      const generation = (reloadGenerationsRef.current.get(targetPath) ?? 0) + 1
      reloadGenerationsRef.current.set(targetPath, generation)
      const requestAgentId = ownerAgentId
      const requestOwnerId = ownerIdRef.current
      const requestAgentCreatedAt = agentCreatedAtRef.current
      const initialVersionId = model.getVersionId()
      const isCurrent = () =>
        !disposedRef.current &&
        !model.isDisposed() &&
        modelsRef.current.get(codeModelKey(requestAgentId, targetPath)) === model &&
        reloadGenerationsRef.current.get(targetPath) === generation &&
        agentIdRef.current === requestAgentId &&
        ownerIdRef.current === requestOwnerId &&
        agentCreatedAtRef.current === requestAgentCreatedAt
      try {
        const raw = await runTengriAction<unknown>({ action: 'read-file', agentId: requestAgentId, path: targetPath })
        if (!isCurrent()) return
        const decoded = decodeCodeFileSnapshot(raw)
        if (!decoded) throw new Error('Tengri returned an invalid file revision receipt.')
        if (model.getVersionId() !== initialVersionId) return
        if (decoded.kind === 'legacy') {
          setReadOnlyPath(targetPath, true)
          patchTab(targetPath, { state: 'ready', error: LEGACY_REVISION_MESSAGE })
          return
        }
        const snapshot = decoded.snapshot
        const prompt = draftPromptsRef.current.get(targetPath)
        const draftId = prompt?.draft.draftId ?? sourceDraftIdsRef.current.get(targetPath)
        if (draftId) {
          if (!removeDraftById(targetPath, draftId)) return
          sourceDraftIdsRef.current.delete(targetPath)
          sourceDraftsRef.current.delete(targetPath)
        }
        if (!removeDraft(targetPath)) return
        loadingPathsRef.current.add(codeModelKey(requestAgentId, targetPath))
        try {
          model.setValue(snapshot.content)
        } finally {
          loadingPathsRef.current.delete(codeModelKey(requestAgentId, targetPath))
        }
        baseRevisionsRef.current.set(targetPath, snapshot.revision)
        contentTypesRef.current.set(targetPath, snapshot.contentType)
        lastSavedRef.current.set(targetPath, snapshot.content)
        conflictedPathsRef.current.delete(targetPath)
        unverifiedPathsRef.current.delete(targetPath)
        conflictSnapshotsRef.current.delete(targetPath)
        setDraftPrompt(null, targetPath)
        patchTab(targetPath, { dirty: false, state: 'ready', error: '' })
        setReadOnlyPath(targetPath, false)
      } catch (cause) {
        if (!isCurrent()) return
        patchTab(targetPath, {
          state: 'error',
          error: cause instanceof Error ? cause.message : 'The guest file could not be reloaded.',
        })
      }
    },
    [ownerAgentId, patchTab, removeDraft, removeDraftById, setDraftPrompt, setReadOnlyPath],
  )

  const mergeCurrentConflict = useCallback(
    (targetPath: string) => {
      const snapshot = conflictSnapshotsRef.current.get(targetPath)
      const model = modelsRef.current.get(codeModelKey(ownerAgentId, targetPath))
      if (!snapshot || !model || model.isDisposed()) return
      contentTypesRef.current.set(targetPath, snapshot.contentType)
      conflictSnapshotsRef.current.delete(targetPath)
      conflictedPathsRef.current.delete(targetPath)
      const merged = mergeCodeDraftContent(snapshot.content, model.getValue())
      if (applyDraftContent(targetPath, merged, snapshot.revision, true)) setDraftPrompt(null, targetPath)
    },
    [applyDraftContent, ownerAgentId, setDraftPrompt],
  )

  const downloadDraft = useCallback(
    (targetPath: string) => {
      const draft = pendingDraftsRef.current.get(targetPath) ?? rememberedCodeDraft(draftIdentity(targetPath))
      if (!draft) return
      const blob = new Blob([draft.content], { type: draft.contentType || CODE_CONTENT_TYPE_FALLBACK })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${codeFileName(targetPath)}.tengri-draft`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
    },
    [draftIdentity],
  )

  const retryConflictSave = useCallback(
    (targetPath: string) => {
      const model = modelsRef.current.get(codeModelKey(ownerAgentId, targetPath))
      const baseRevision = baseRevisionsRef.current.get(targetPath)
      if (!model || baseRevision === undefined) return
      if (!conflictSnapshotsRef.current.has(targetPath)) {
        void refreshConflictSnapshot(targetPath, model.getValue(), baseRevision)
        return
      }
      void flushPath(targetPath)
    },
    [flushPath, ownerAgentId, refreshConflictSnapshot],
  )
  reloadPathRef.current = (targetPath) => loadPath(targetPath, true)

  const rehomeDraft = useCallback(
    (targetPath: string, sourceDraft: CodeDraft): { draft: CodeDraft; durable: boolean } => {
      const draft = createCodeDraft(
        draftIdentity(targetPath),
        sourceDraft.content,
        sourceDraft.baseRevision,
        sourceDraft.contentType,
        sourceDraft.updatedAt,
        sourceDraft.draftId,
      )
      rememberCodeDraft(draft)
      const result = draftStoreRef.current?.write(draft)
      if (result?.kind === 'stored') {
        markCodeDraftDurable(draft)
        return { draft, durable: true }
      }
      markCodeDraftVolatile(draft)
      setDraftError(
        result?.message ??
          'Browser storage is unavailable, so Code could not move this draft with the renamed file. Download it before closing the editor.',
      )
      return { draft, durable: false }
    },
    [draftIdentity],
  )

  useEffect(() => {
    disposedRef.current = false
    setEditorReady(false)
    setEditorError('')
    let cancelled = false
    let editor: Editor | null = null

    async function mountEditor() {
      if (!hostRef.current || editorRef.current) return
      configureMonacoWorkers()
      try {
        const monaco = await import('monaco-editor')
        if (cancelled || disposedRef.current || !hostRef.current || editorRef.current) return
        monacoRef.current = monaco
        editor = monaco.editor.create(hostRef.current, {
          accessibilitySupport: 'auto',
          ariaLabel: 'Tengri Code editor',
          automaticLayout: true,
          fontFamily: 'JetBrains Mono, SFMono-Regular, Menlo, monospace',
          fontLigatures: true,
          fontSize: 13,
          lineHeight: 21,
          minimap: { enabled: false },
          padding: { top: 14, bottom: 14 },
          renderLineHighlight: 'gutter',
          roundedSelection: true,
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          tabSize: 2,
          theme: 'vs-dark',
        })
        editorRef.current = editor
        editor.onDidChangeCursorPosition(({ position }) =>
          setCursor({ line: position.lineNumber, column: position.column }),
        )
        editor.onDidChangeModelContent(() => {
          const model = editorRef.current?.getModel()
          const targetPath = model?.uri.path ?? ''
          const modelKey = targetPath ? codeModelKey(agentIdRef.current, targetPath) : ''
          if (!model || modelsRef.current.get(modelKey) !== model || loadingPathsRef.current.has(modelKey)) return
          if (unverifiedPathsRef.current.delete(targetPath)) {
            conflictedPathsRef.current.add(targetPath)
            persistDraftRef.current(targetPath, model.getValue())
            patchTabRef.current(targetPath, {
              dirty: true,
              state: 'error',
              error: 'File verification failed before local edits. Retry or choose Save mine.',
            })
            return
          }
          if (conflictedPathsRef.current.has(targetPath)) {
            persistDraftRef.current(targetPath, model.getValue())
            patchTabRef.current(targetPath, { dirty: true })
            return
          }
          if (
            isEditorValuePersisted(
              model.getValue(),
              lastSavedRef.current.get(targetPath),
              saveQueuesRef.current.has(targetPath),
            )
          ) {
            const timer = saveTimersRef.current.get(targetPath)
            if (timer) window.clearTimeout(timer)
            saveTimersRef.current.delete(targetPath)
            removeDraftRef.current(targetPath)
            setDraftPromptRef.current(null, targetPath)
            patchTabRef.current(targetPath, { dirty: false, state: 'ready', error: '' })
            return
          }
          const prompt = draftPromptsRef.current.get(targetPath)
          if (prompt && model.getValue() !== prompt.server.content) setDraftPromptRef.current(null, targetPath)
          persistDraftRef.current(targetPath, model.getValue())
          scheduleSaveRef.current(targetPath, model)
        })
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => flushActiveRef.current())
        setEditorReady(true)
      } catch (cause) {
        if (!cancelled) setEditorError(cause instanceof Error ? cause.message : 'Code editor could not start')
      }
    }

    void mountEditor()
    return () => {
      cancelled = true
      for (const tab of tabsRef.current) {
        if (!tab.dirty) continue
        const model = modelsRef.current.get(codeModelKey(agentIdRef.current, tab.path))
        if (model) persistDraftRef.current(tab.path, model.getValue())
      }
      disposedRef.current = true
      for (const controller of requestsRef.current.values()) controller.abort()
      requestsRef.current.clear()
      conflictReadGenerationsRef.current.clear()
      reloadGenerationsRef.current.clear()
      for (const controller of writeControllersRef.current.values()) controller.abort()
      writeControllersRef.current.clear()
      for (const timer of saveTimersRef.current.values()) window.clearTimeout(timer)
      saveTimersRef.current.clear()
      for (const timers of recentWriteTimersRef.current.values()) {
        for (const timer of timers.values()) window.clearTimeout(timer)
      }
      recentWriteTimersRef.current.clear()
      for (const timer of pendingRenameTimersRef.current.values()) window.clearTimeout(timer)
      pendingRenameTimersRef.current.clear()
      writeEchoesRef.current.clear()
      conflictedPathsRef.current.clear()
      unverifiedPathsRef.current.clear()
      migratingPathsRef.current.clear()
      baseRevisionsRef.current.clear()
      contentTypesRef.current.clear()
      conflictSnapshotsRef.current.clear()
      draftPromptsRef.current.clear()
      sourceDraftIdsRef.current.clear()
      sourceDraftsRef.current.clear()
      readOnlyPathsRef.current.clear()
      editor?.dispose()
      editorRef.current = null
      disposeCodeModels(modelsRef.current)
      monacoRef.current = null
    }
  }, [])

  useEffect(() => {
    if (ownerAgentId === agentId && ownerIdRef.current === ownerId && agentCreatedAtRef.current === agentCreatedAt)
      return
    if (
      tabsRef.current.some((tab) => tab.dirty) ||
      saveTimersRef.current.size > 0 ||
      saveQueuesRef.current.size > 0 ||
      pendingRenameTimersRef.current.size > 0
    ) {
      setOwnerWarning('Finish saving or close edited files before switching agents.')
      return
    }
    for (const controller of requestsRef.current.values()) controller.abort()
    requestsRef.current.clear()
    conflictReadGenerationsRef.current.clear()
    reloadGenerationsRef.current.clear()
    for (const controller of writeControllersRef.current.values()) controller.abort()
    writeControllersRef.current.clear()
    for (const timer of saveTimersRef.current.values()) window.clearTimeout(timer)
    saveTimersRef.current.clear()
    pendingRequestsRef.current = []
    processedRequestsRef.current.clear()
    watchCursorsRef.current.clear()
    for (const timer of pendingRenameTimersRef.current.values()) window.clearTimeout(timer)
    pendingRenameTimersRef.current.clear()
    lastSavedRef.current.clear()
    baseRevisionsRef.current.clear()
    contentTypesRef.current.clear()
    conflictSnapshotsRef.current.clear()
    draftPromptsRef.current.clear()
    draftIdsRef.current.clear()
    sourceDraftIdsRef.current.clear()
    sourceDraftsRef.current.clear()
    pendingDraftsRef.current.clear()
    readOnlyPathsRef.current.clear()
    setReadOnlyPaths(new Set())
    setDraftPromptVersion((version) => version + 1)
    writeEchoesRef.current.clear()
    conflictedPathsRef.current.clear()
    unverifiedPathsRef.current.clear()
    migratingPathsRef.current.clear()
    editorRef.current?.setModel(null)
    disposeCodeModels(modelsRef.current)
    tabsRef.current = []
    setTabs([])
    activePathRef.current = ''
    setActivePath('')
    setCursor({ line: 1, column: 1 })
    agentIdRef.current = agentId
    agentCreatedAtRef.current = agentCreatedAt
    ownerIdRef.current = ownerId
    setOwnerAgentId(agentId)
    setOwnerWarning('')
  }, [agentCreatedAt, agentId, ownerId, ownerAgentId, tabs])

  const requestPath = request?.path ?? ''
  const requestId = request?.requestId ?? -1
  useEffect(() => {
    if (requestId < 0 || !isCodePath(requestPath)) return
    const nextRequest = { path: requestPath, requestId }
    const requestKey = codeOpenRequestKey(nextRequest)
    if (processedRequestsRef.current.has(requestKey)) return
    const parent = codeParentDirectory(requestPath)
    const directories = new Set(tabsRef.current.map((tab) => codeParentDirectory(tab.path)))
    if (!directories.has(parent) && directories.size >= MAX_CODE_WATCH_DIRECTORIES) {
      setEditorError(codeWatchDirectoryLimitError())
      return
    }
    setEditorError(clearCodeWatchDirectoryLimitError)
    processedRequestsRef.current.add(requestKey)
    updateTabs((current) => openEditorTab(current, requestPath))
    activePathRef.current = requestPath
    setActivePath(requestPath)
    if (!editorReady) {
      pendingRequestsRef.current = enqueueCodeOpenRequest(pendingRequestsRef.current, nextRequest)
      return
    }
    void loadPath(requestPath, !tabsRef.current.find((tab) => tab.path === requestPath)?.dirty)
  }, [editorReady, loadPath, ownerAgentId, requestId, requestPath, updateTabs])

  useEffect(() => {
    if (!editorReady || pendingRequestsRef.current.length === 0) return
    const pendingRequests = pendingRequestsRef.current
    pendingRequestsRef.current = []
    for (const pendingRequest of pendingRequests) void loadPath(pendingRequest.path, true)
  }, [editorReady, loadPath])

  const migratePath = useCallback(
    async (previousPath: string, path: string) => {
      if (!isCodePath(path) || previousPath === path) return
      clearPendingRename(previousPath)
      conflictedPathsRef.current.delete(previousPath)
      unverifiedPathsRef.current.delete(previousPath)
      migratingPathsRef.current.add(previousPath)
      try {
        const timer = saveTimersRef.current.get(previousPath)
        if (timer) window.clearTimeout(timer)
        saveTimersRef.current.delete(previousPath)
        writeControllersRef.current.get(previousPath)?.abort()
        while (saveQueuesRef.current.has(previousPath)) await saveQueuesRef.current.get(previousPath)
        if (disposedRef.current) return
        if (tabsRef.current.some((tab) => tab.path === path)) {
          markConflict(previousPath, 'File was renamed to a path that is already open in Code.')
          return
        }

        const recentWriteTimers = recentWriteTimersRef.current.get(previousPath)
        if (recentWriteTimers) {
          for (const recentWriteTimer of recentWriteTimers.values()) window.clearTimeout(recentWriteTimer)
        }
        recentWriteTimersRef.current.delete(previousPath)
        writeEchoesRef.current.clearPath(previousPath)
        const previousModelKey = codeModelKey(ownerAgentId, previousPath)
        const nextModelKey = codeModelKey(ownerAgentId, path)
        requestsRef.current.get(previousModelKey)?.abort()
        requestsRef.current.delete(previousModelKey)

        const previousTab = tabsRef.current.find((tab) => tab.path === previousPath)
        const previousModel = modelsRef.current.get(previousModelKey)
        const previousContent = previousModel?.getValue()
        const monaco = monacoRef.current
        let nextModel: TextModel | null = null
        if (previousModel && monaco) {
          const uri = monaco.Uri.from({
            scheme: 'tengri',
            authority: 'code',
            path,
            query: `agent=${encodeURIComponent(ownerAgentId)}&editor=${editorInstanceId}`,
          })
          nextModel = monaco.editor.createModel(previousContent ?? '', codeLanguage(path), uri)
          modelsRef.current.delete(previousModelKey)
          modelsRef.current.set(nextModelKey, nextModel)
          previousModel.dispose()
        }

        const lastSaved = lastSavedRef.current.get(previousPath)
        lastSavedRef.current.delete(previousPath)
        if (lastSaved !== undefined) lastSavedRef.current.set(path, lastSaved)
        const baseRevision = baseRevisionsRef.current.get(previousPath)
        baseRevisionsRef.current.delete(previousPath)
        if (baseRevision !== undefined) baseRevisionsRef.current.set(path, baseRevision)
        const contentType = contentTypesRef.current.get(previousPath)
        contentTypesRef.current.delete(previousPath)
        if (contentType !== undefined) contentTypesRef.current.set(path, contentType)
        const previousDraftId = draftIdsRef.current.get(previousPath)
        const previousDraft = pendingDraftsRef.current.get(previousPath)
        const previousSourceDraftId = sourceDraftIdsRef.current.get(previousPath)
        const previousSourceDraft = sourceDraftsRef.current.get(previousPath)
        removeDraft(previousPath)
        draftIdsRef.current.delete(previousPath)
        pendingDraftsRef.current.delete(previousPath)
        if (previousDraftId !== undefined) draftIdsRef.current.set(path, previousDraftId)
        if (previousDraft && previousTab?.dirty)
          persistDraft(path, previousContent ?? previousDraft.content, baseRevision)
        if (previousSourceDraftId && previousSourceDraft) {
          const moved = rehomeDraft(path, previousSourceDraft)
          if (moved.durable) removeDraftById(previousPath, previousSourceDraftId)
          sourceDraftIdsRef.current.delete(previousPath)
          sourceDraftsRef.current.delete(previousPath)
          sourceDraftIdsRef.current.set(path, moved.draft.draftId)
          sourceDraftsRef.current.set(path, moved.draft)
          const currentDraft = pendingDraftsRef.current.get(path)
          if (!currentDraft || moved.draft.updatedAt >= currentDraft.updatedAt)
            pendingDraftsRef.current.set(path, moved.draft)
        }
        const conflictSnapshot = conflictSnapshotsRef.current.get(previousPath)
        conflictSnapshotsRef.current.delete(previousPath)
        if (conflictSnapshot) conflictSnapshotsRef.current.set(path, conflictSnapshot)
        const readOnly = readOnlyPathsRef.current.has(previousPath)
        if (readOnly) {
          readOnlyPathsRef.current.delete(previousPath)
          readOnlyPathsRef.current.add(path)
        }
        setReadOnlyPaths(new Set(readOnlyPathsRef.current))
        if (previousTab?.dirty) conflictedPathsRef.current.add(path)
        conflictedPathsRef.current.delete(previousPath)
        const renamed = renameEditorTab(tabsRef.current, activePathRef.current, previousPath, path)
        const nextTabs = renamed.tabs.map((tab) =>
          tab.path === path
            ? {
                ...tab,
                dirty: previousTab?.dirty ?? false,
                state: previousTab?.dirty ? ('error' as const) : ('loading' as const),
                error: previousTab?.dirty ? 'File was renamed outside Code while local edits were pending.' : '',
              }
            : tab,
        )
        updateTabs(() => nextTabs)
        activePathRef.current = renamed.activePath
        setActivePath(renamed.activePath)
        if (renamed.activePath === path && nextModel) editorRef.current?.setModel(nextModel)
        if (!previousTab?.dirty) void loadPath(path, true)
      } finally {
        migratingPathsRef.current.delete(previousPath)
      }
    },
    [
      clearPendingRename,
      editorInstanceId,
      loadPath,
      markConflict,
      ownerAgentId,
      persistDraft,
      rehomeDraft,
      removeDraft,
      removeDraftById,
      updateTabs,
    ],
  )

  useEffect(() => {
    const directories = watchDirectoryKey ? watchDirectoryKey.split('\0') : []
    if (!directories.length) {
      setWatchState('connected')
      return
    }

    setWatchState('reconnecting')
    const connected = new Set<string>()
    const verifications = new Map<string, AbortController>()
    let closed = false
    const cancelVerification = (targetPath: string) => {
      verifications.get(targetPath)?.abort()
      verifications.delete(targetPath)
    }
    const verifyChange = (targetPath: string) => {
      cancelVerification(targetPath)
      const controller = new AbortController()
      verifications.set(targetPath, controller)
      const modelKey = codeModelKey(ownerAgentId, targetPath)
      const model = modelsRef.current.get(modelKey)
      const isCurrent = () =>
        !closed &&
        !disposedRef.current &&
        verifications.get(targetPath) === controller &&
        modelsRef.current.get(modelKey) === model
      void runTengriAction<unknown>({ action: 'read-file', agentId: ownerAgentId, path: targetPath }, controller.signal)
        .then((raw) => {
          if (!isCurrent()) return
          const current = tabsRef.current.find((tab) => tab.path === targetPath)
          if (!current) return
          const decoded = decodeCodeFileSnapshot(raw)
          if (!decoded) {
            markUnverified(targetPath, 'The guest returned an invalid file revision. Retry before editing.')
            return
          }
          if (decoded.kind === 'legacy') {
            setReadOnlyPath(targetPath, true)
            if (current.dirty) markConflict(targetPath, LEGACY_REVISION_MESSAGE)
            else patchTab(targetPath, { state: 'ready', error: LEGACY_REVISION_MESSAGE })
            return
          }
          if (writeEchoesRef.current.matches(targetPath, decoded.snapshot.content)) {
            baseRevisionsRef.current.set(targetPath, decoded.snapshot.revision)
            return
          }
          if (current.dirty) {
            conflictSnapshotsRef.current.set(targetPath, decoded.snapshot)
            markConflict(targetPath, 'File changed outside Code while local edits were pending.')
          } else void loadPath(targetPath, true)
        })
        .catch((cause: unknown) => {
          if (!isCurrent() || controller.signal.aborted) return
          const error = cause instanceof Error ? cause.message : 'File change could not be verified'
          const failure = codeVerificationFailure(
            tabsRef.current.find((tab) => tab.path === targetPath),
            error,
          )
          if (!failure) return
          if (failure.conflict) markConflict(targetPath, error)
          else markUnverified(targetPath, error)
        })
        .finally(() => {
          if (verifications.get(targetPath) === controller) verifications.delete(targetPath)
        })
    }
    const handleMessage = (directory: string, message: MessageEvent<string>) => {
      if (closed) return
      let event: TengriFileEvent
      try {
        event = JSON.parse(message.data) as TengriFileEvent
      } catch {
        return
      }
      watchCursorsRef.current.set(directory, Math.max(watchCursorsRef.current.get(directory) ?? 0, event.sequence))

      if (event.kind === 'reset') {
        for (const tab of tabsRef.current.filter((candidate) => codeParentDirectory(candidate.path) === directory)) {
          cancelVerification(tab.path)
          if (tab.dirty) markConflict(tab.path, 'Filesystem state changed while local edits were pending.')
          else void loadPath(tab.path, true)
        }
        return
      }

      const affected = tabsRef.current.find(
        (tab) => tab.path === event.path || (event.previousPath && tab.path === event.previousPath),
      )
      if (!affected) return
      cancelVerification(affected.path)
      if (event.kind === 'renamed' && event.path && event.previousPath) {
        void migratePath(event.previousPath, event.path)
        return
      }
      if (event.kind === 'removed') {
        markConflict(affected.path, 'File was removed outside Code.')
        return
      }
      if (event.kind === 'renamed' && !event.previousPath) {
        deferUnpairedRename(affected.path)
        return
      }
      if (event.kind === 'changed' || event.kind === 'created') verifyChange(affected.path)
    }

    const sources = directories.map((directory) => {
      const params = new URLSearchParams({ agentId: ownerAgentId, path: directory })
      const after = watchCursorsRef.current.get(directory)
      if (after !== undefined) params.set('after', String(after))
      const source = new EventSource(`/api/tengri/files/events?${params}`)
      source.onopen = () => {
        if (closed) return
        connected.add(directory)
        if (connected.size === directories.length) setWatchState('connected')
      }
      source.onerror = () => {
        if (closed) return
        connected.delete(directory)
        setWatchState('reconnecting')
      }
      source.onmessage = (message) => handleMessage(directory, message)
      return source
    })
    return () => {
      closed = true
      for (const controller of verifications.values()) controller.abort()
      verifications.clear()
      for (const source of sources) source.close()
    }
  }, [
    deferUnpairedRename,
    loadPath,
    markConflict,
    markUnverified,
    migratePath,
    ownerAgentId,
    patchTab,
    setReadOnlyPath,
    watchDirectoryKey,
  ])

  const hasDirtyTabs = tabs.some((tab) => tab.dirty)
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange
  }, [onDirtyChange])
  useEffect(() => onDirtyChange?.(hasDirtyTabs), [hasDirtyTabs, onDirtyChange])
  useEffect(() => () => onDirtyChangeRef.current?.(false), [])

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!tabsRef.current.some((tab) => tab.dirty)) return
      event.preventDefault()
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [])

  function activateTab(targetPath: string) {
    activePathRef.current = targetPath
    setActivePath(targetPath)
    if (!showPath(targetPath)) void loadPath(targetPath)
  }

  function closeTabNow(targetPath: string) {
    reloadGenerationsRef.current.set(targetPath, (reloadGenerationsRef.current.get(targetPath) ?? 0) + 1)
    const modelKey = codeModelKey(ownerAgentId, targetPath)
    requestsRef.current.get(modelKey)?.abort()
    requestsRef.current.delete(modelKey)
    const timer = saveTimersRef.current.get(targetPath)
    if (timer) window.clearTimeout(timer)
    saveTimersRef.current.delete(targetPath)
    const recentWriteTimers = recentWriteTimersRef.current.get(targetPath)
    if (recentWriteTimers) {
      for (const recentWriteTimer of recentWriteTimers.values()) window.clearTimeout(recentWriteTimer)
    }
    recentWriteTimersRef.current.delete(targetPath)
    clearPendingRename(targetPath)
    writeEchoesRef.current.clearPath(targetPath)
    conflictedPathsRef.current.delete(targetPath)
    unverifiedPathsRef.current.delete(targetPath)
    baseRevisionsRef.current.delete(targetPath)
    contentTypesRef.current.delete(targetPath)
    conflictSnapshotsRef.current.delete(targetPath)
    draftPromptsRef.current.delete(targetPath)
    draftIdsRef.current.delete(targetPath)
    sourceDraftIdsRef.current.delete(targetPath)
    sourceDraftsRef.current.delete(targetPath)
    pendingDraftsRef.current.delete(targetPath)
    readOnlyPathsRef.current.delete(targetPath)
    setReadOnlyPaths(new Set(readOnlyPathsRef.current))
    setDraftPromptVersion((version) => version + 1)
    const model = modelsRef.current.get(modelKey)
    if (model) {
      modelsRef.current.delete(modelKey)
      model.dispose()
    }
    const next = closeEditorTab(tabsRef.current, activePathRef.current, targetPath)
    updateTabs(() => next.tabs)
    activePathRef.current = next.activePath
    setActivePath(next.activePath)
    if (!next.activePath) editorRef.current?.setModel(null)
    else if (!showPath(next.activePath)) {
      editorRef.current?.setModel(null)
      void loadPath(next.activePath)
    }
    if (next.activePath) {
      requestAnimationFrame(() => document.getElementById(tabId(editorInstanceId, next.activePath))?.focus())
    }
  }

  function closeTab(targetPath: string) {
    const tab = tabsRef.current.find((candidate) => candidate.path === targetPath)
    if (!tab) return
    if (tab.dirty) {
      setCloseError('')
      setPendingClose(tab)
      return
    }
    closeTabNow(targetPath)
  }

  async function saveAndClose() {
    if (!pendingClose) return
    setCloseBusy(true)
    setCloseError('')
    const saved = await flushPath(pendingClose.path)
    if (saved) {
      closeTabNow(pendingClose.path)
      setPendingClose(null)
    } else {
      setCloseError('Tengri could not save this file. The tab remains open so your changes are preserved.')
    }
    setCloseBusy(false)
  }

  function moveTabFocus(targetPath: string, direction: 'end' | 'home' | 'next' | 'previous') {
    const index = tabsRef.current.findIndex((tab) => tab.path === targetPath)
    if (index < 0) return
    const targetIndex =
      direction === 'home'
        ? 0
        : direction === 'end'
          ? tabsRef.current.length - 1
          : (index + (direction === 'previous' ? -1 : 1) + tabsRef.current.length) % tabsRef.current.length
    const next = tabsRef.current[targetIndex]
    if (!next) return
    activateTab(next.path)
    requestAnimationFrame(() => document.getElementById(tabId(editorInstanceId, next.path))?.focus())
  }

  const activeTab = tabs.find((tab) => tab.path === activePath)
  const activeDraftPrompt = draftPromptsRef.current.get(activePath)
  const activeConflictSnapshot = conflictSnapshotsRef.current.get(activePath)
  const activeReadOnly = readOnlyPaths.has(activePath)
  const panelId = codePanelId(editorInstanceId)
  return (
    <div className="flex h-full min-h-0 flex-col bg-[#111318]" data-shortcuts="native">
      <div
        role="tablist"
        aria-label="Open files"
        className="flex h-10 shrink-0 items-end overflow-x-auto border-b border-white/8 bg-white/[0.025] px-1 pt-1"
      >
        {tabs.length ? (
          tabs.map((tab) => (
            <div
              key={tab.path}
              role="presentation"
              className={`group flex h-9 min-w-36 max-w-52 items-center gap-1 rounded-t-lg border-x border-t px-1 text-xs ${
                tab.path === activePath
                  ? 'border-white/8 bg-[#111318] text-white/82'
                  : 'border-transparent text-white/42 hover:bg-white/5'
              }`}
            >
              <button
                type="button"
                id={tabId(editorInstanceId, tab.path)}
                role="tab"
                aria-controls={panelId}
                aria-selected={tab.path === activePath}
                tabIndex={tab.path === activePath ? 0 : -1}
                onClick={() => activateTab(tab.path)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft') moveTabFocus(tab.path, 'previous')
                  else if (event.key === 'ArrowRight') moveTabFocus(tab.path, 'next')
                  else if (event.key === 'Home') moveTabFocus(tab.path, 'home')
                  else if (event.key === 'End') moveTabFocus(tab.path, 'end')
                  else return
                  event.preventDefault()
                }}
                className="flex min-w-0 flex-1 items-center gap-2 px-2"
              >
                <FileCode2 className="h-3.5 w-3.5 shrink-0 text-[#79b8ff]" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-left">{codeFileName(tab.path)}</span>
                {tab.dirty ? (
                  <>
                    <span className="h-1.5 w-1.5 rounded-full bg-white/65" aria-hidden="true" />
                    <span className="sr-only">Unsaved changes</span>
                  </>
                ) : null}
                {tab.state === 'loading' || tab.state === 'saving' ? (
                  <LoaderCircle
                    className="h-3 w-3 animate-spin"
                    aria-label={tab.state === 'saving' ? 'Saving' : 'Loading'}
                  />
                ) : null}
                {tab.state === 'error' ? <CircleAlert className="h-3 w-3 text-red-300" aria-label="Error" /> : null}
              </button>
              <button
                type="button"
                aria-label={`Close ${codeFileName(tab.path)}`}
                onClick={() => closeTab(tab.path)}
                className="rounded p-0.5 opacity-0 hover:bg-white/10 group-hover:opacity-100 focus:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))
        ) : (
          <div className="flex h-9 items-center gap-2 px-3 text-xs text-white/38">
            <FileCode2 className="h-3.5 w-3.5" /> Choose a file in Finder
          </div>
        )}
      </div>

      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={activePath ? tabId(editorInstanceId, activePath) : undefined}
        className="relative min-h-0 flex-1"
      >
        <div ref={hostRef} className="absolute inset-0" />
        <div className="pointer-events-none absolute inset-x-2 top-2 z-20 flex flex-col gap-2">
          {draftError ? (
            <div
              role="alert"
              className="pointer-events-auto flex items-center gap-3 rounded-lg border border-amber-200/20 bg-amber-950/90 px-3 py-2 text-xs text-amber-100 shadow-lg"
            >
              <span className="min-w-0 flex-1">{draftError}</span>
              {activePath && pendingDraftsRef.current.has(activePath) ? (
                <button type="button" className="shrink-0 text-[#9bc8ff]" onClick={() => downloadDraft(activePath)}>
                  Download draft
                </button>
              ) : null}
            </div>
          ) : null}
          {activeReadOnly ? (
            <div
              role="alert"
              className="pointer-events-auto flex items-center gap-3 rounded-lg border border-amber-200/20 bg-amber-950/90 px-3 py-2 text-xs text-amber-100 shadow-lg"
            >
              <span className="min-w-0 flex-1">{LEGACY_REVISION_MESSAGE}</span>
              <button type="button" className="shrink-0 text-[#9bc8ff]" onClick={() => void loadPath(activePath, true)}>
                Retry after resume
              </button>
            </div>
          ) : null}
          {activeDraftPrompt?.kind === 'recoverable' ? (
            <div
              role="alert"
              className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-lg border border-sky-200/20 bg-sky-950/90 px-3 py-2 text-xs text-sky-100 shadow-lg"
            >
              <span className="mr-auto min-w-0">A recoverable draft is available for this file.</span>
              <button type="button" className="text-[#b7d7ff]" onClick={() => recoverDraft(activeDraftPrompt.path)}>
                Recover draft
              </button>
              <button type="button" className="text-white/70" onClick={() => downloadDraft(activeDraftPrompt.path)}>
                Download draft
              </button>
              <button
                type="button"
                className="text-white/70"
                onClick={() => {
                  const prompt = activeDraftPrompt
                  if (removeDraftById(prompt.path, prompt.draft.draftId)) {
                    sourceDraftIdsRef.current.delete(prompt.path)
                    sourceDraftsRef.current.delete(prompt.path)
                    const nextDraft = findAvailableDraft(prompt.path)
                    if (nextDraft) {
                      sourceDraftIdsRef.current.set(prompt.path, nextDraft.draftId)
                      sourceDraftsRef.current.set(prompt.path, nextDraft)
                      pendingDraftsRef.current.set(prompt.path, nextDraft)
                      setDraftPrompt(
                        {
                          kind: nextDraft.baseRevision === prompt.server.revision ? 'recoverable' : 'conflict',
                          path: prompt.path,
                          draft: nextDraft,
                          server: prompt.server,
                        },
                        prompt.path,
                      )
                    } else setDraftPrompt(null, prompt.path)
                  }
                }}
              >
                Discard draft
              </button>
            </div>
          ) : null}
          {activeDraftPrompt?.kind === 'conflict' ? (
            <div
              role="alert"
              className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-lg border border-red-200/20 bg-red-950/90 px-3 py-2 text-xs text-red-100 shadow-lg"
            >
              <span className="mr-auto min-w-0">
                This draft is based on an older guest file. Choose how to continue.
              </span>
              <button
                type="button"
                className="text-[#ffcfb7]"
                onClick={() => keepConflictingDraft(activeDraftPrompt.path)}
              >
                Keep local draft
              </button>
              <button
                type="button"
                className="text-[#ffcfb7]"
                onClick={() => mergeConflictingDraft(activeDraftPrompt.path)}
              >
                Merge draft
              </button>
              <button type="button" className="text-white/70" onClick={() => downloadDraft(activeDraftPrompt.path)}>
                Download draft
              </button>
              <button type="button" className="text-white/70" onClick={() => reloadDraftServer(activeDraftPrompt.path)}>
                Reload server
              </button>
            </div>
          ) : null}
        </div>
        {!editorReady && !editorError ? (
          <div role="status" className="absolute inset-0 grid place-items-center bg-[#111318] text-sm text-white/35">
            <span className="flex items-center gap-2">
              <LoaderCircle className="h-4 w-4 animate-spin" /> Starting Code…
            </span>
          </div>
        ) : null}
        {editorError ? (
          <div role="alert" className="absolute inset-0 grid place-items-center bg-[#111318] p-8 text-sm text-red-200">
            {editorError}
          </div>
        ) : null}
        {editorReady && !activePath ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center bg-[#111318] text-sm text-white/30">
            Open a file from Finder or Spotlight
          </div>
        ) : null}
        {editorReady && activeTab?.state === 'loading' ? (
          <div role="status" className="absolute inset-0 grid place-items-center bg-[#111318] text-sm text-white/35">
            <span className="flex items-center gap-2">
              <LoaderCircle className="h-4 w-4 animate-spin" /> Opening {codeFileName(activeTab.path)}…
            </span>
          </div>
        ) : null}
        {editorReady && activeTab?.state === 'error' && !activeTab.dirty ? (
          <div role="alert" className="absolute inset-0 grid place-items-center bg-[#111318] p-8 text-sm text-red-200">
            <div className="max-w-lg text-center">
              <p>{activeTab.error}</p>
              <button type="button" className="mt-3 text-[#79b8ff]" onClick={() => void loadPath(activeTab.path, true)}>
                Retry
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex h-6 shrink-0 items-center border-t border-white/7 bg-[#171a21] px-3 text-[10px] text-white/42">
        <span className="max-w-[55%] truncate">{activePath || 'No file selected'}</span>
        <span className="ml-auto">
          Ln {cursor.line}, Col {cursor.column}
        </span>
        <span className="ml-4">{codeLanguage(activePath)}</span>
        <span className="ml-4 flex items-center gap-1" role="status" aria-live="polite">
          {activeTab?.state === 'loading' || activeTab?.state === 'saving' ? (
            <LoaderCircle className="h-3 w-3 animate-spin" />
          ) : null}
          {activeTab?.state === 'ready' ? <Check className="h-3 w-3 text-emerald-400" /> : null}
          {activeTab?.state === 'error' ? <CircleAlert className="h-3 w-3 text-red-300" /> : null}
          <span className={activeTab?.state === 'error' ? 'max-w-64 truncate text-red-300' : ''}>
            {activeTab?.error || (activeTab?.state === 'ready' ? 'saved' : activeTab?.state) || 'idle'}
          </span>
          {activeTab?.state === 'error' && !activeTab.dirty ? (
            <button type="button" className="ml-1 text-[#79b8ff]" onClick={() => void loadPath(activeTab.path, true)}>
              Retry
            </button>
          ) : null}
          {activeTab?.state === 'error' && activeTab.dirty ? (
            <>
              {activeConflictSnapshot ? (
                <>
                  <button
                    type="button"
                    className="ml-1 text-[#79b8ff]"
                    onClick={() => reloadDraftServer(activeTab.path)}
                  >
                    Reload server
                  </button>
                  <button
                    type="button"
                    className="ml-1 text-[#79b8ff]"
                    onClick={() => mergeCurrentConflict(activeTab.path)}
                  >
                    Merge
                  </button>
                </>
              ) : null}
              <button type="button" className="ml-1 text-[#79b8ff]" onClick={() => retryConflictSave(activeTab.path)}>
                Save mine
              </button>
            </>
          ) : null}
        </span>
        <span className={`ml-4 ${watchState === 'connected' ? 'text-emerald-400' : 'text-amber-300'}`}>
          {watchState === 'connected' ? 'Watching' : 'Reconnecting'}
        </span>
        {ownerWarning ? (
          <span role="alert" className="ml-4 max-w-72 truncate text-amber-300" title={ownerWarning}>
            {ownerWarning}
          </span>
        ) : null}
      </div>

      <ConfirmationDialog
        busy={closeBusy}
        confirmLabel="Save and Close"
        destructive={false}
        description={`Tengri will save the pending changes in “${pendingClose ? codeFileName(pendingClose.path) : ''}” before closing the tab.`}
        error={closeError}
        onCancel={() => setPendingClose(null)}
        onConfirm={() => void saveAndClose()}
        open={Boolean(pendingClose)}
        title="Finish saving this file?"
      />
    </div>
  )
}

function tabId(instanceId: string, path: string): string {
  let hash = 2_166_136_261
  for (let index = 0; index < path.length; index += 1) {
    hash ^= path.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return `tengri-code-tab-${instanceId}-${(hash >>> 0).toString(36)}`
}

function decodeCodeFileSnapshot(
  value: unknown,
):
  | { kind: 'legacy'; snapshot: Omit<CodeFileSnapshot, 'revision'> }
  | { kind: 'revisioned'; snapshot: CodeFileSnapshot }
  | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const path = Reflect.get(value, 'path')
  const content = Reflect.get(value, 'content')
  const contentType = Reflect.get(value, 'contentType')
  if (typeof path !== 'string' || !isCodePath(path) || typeof content !== 'string' || typeof contentType !== 'string') {
    return null
  }
  const revisionValue = Reflect.get(value, 'revision')
  if (revisionValue === undefined || revisionValue === '') return { kind: 'legacy', snapshot: { content, contentType } }
  const revision = parseCodeRevision(revisionValue)
  return revision === null ? null : { kind: 'revisioned', snapshot: { content, contentType, revision } }
}

function decodeCodeWriteResult(value: unknown): { path: string; size: number; revision: CodeRevision } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const path = Reflect.get(value, 'path')
  const size = Reflect.get(value, 'size')
  const revision = Reflect.get(value, 'revision')
  if (
    typeof path !== 'string' ||
    !isCodePath(path) ||
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    !isCodeRevision(revision)
  ) {
    return null
  }
  return { path, revision, size }
}
