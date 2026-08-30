'use client'

import { Check, CircleAlert, FileCode2, LoaderCircle, X } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

import type { TengriFileEvent } from '@/lib/tengri/types'
import { MAX_CODE_WATCH_DIRECTORIES } from '@/lib/tengri/limits'

import { runTengriAction } from './client'
import { CodeWriteEchoTracker } from './code-write-echo'
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
  onDirtyChange,
  request,
}: {
  agentId: string
  onDirtyChange?: (dirty: boolean) => void
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
  const loadingPathsRef = useRef(new Set<string>())
  const saveTimersRef = useRef(new Map<string, number>())
  const saveQueuesRef = useRef(new Map<string, Promise<boolean>>())
  const lastSavedRef = useRef(new Map<string, string>())
  const writeEchoesRef = useRef(new CodeWriteEchoTracker())
  const conflictedPathsRef = useRef(new Set<string>())
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
  const [ownerWarning, setOwnerWarning] = useState('')
  const [watchState, setWatchState] = useState<'connected' | 'reconnecting'>('connected')
  const [pendingClose, setPendingClose] = useState<EditorTab | null>(null)
  const [closeBusy, setCloseBusy] = useState(false)
  const [closeError, setCloseError] = useState('')
  const watchDirectoryKey = useMemo(
    () => [...new Set(tabs.map((tab) => codeParentDirectory(tab.path)))].sort().join('\0'),
    [tabs],
  )

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

  const markConflict = useCallback(
    (targetPath: string, error: string) => {
      conflictedPathsRef.current.add(targetPath)
      writeControllersRef.current.get(targetPath)?.abort()
      const timer = saveTimersRef.current.get(targetPath)
      if (timer) window.clearTimeout(timer)
      saveTimersRef.current.delete(targetPath)
      patchTab(targetPath, { dirty: true, state: 'error', error })
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

  const savePath = useCallback(
    (targetPath: string, content: string, versionId: number) => {
      writeEchoesRef.current.begin(targetPath, content)
      patchTab(targetPath, { dirty: true, state: 'saving', error: '' })
      const previous = saveQueuesRef.current.get(targetPath) ?? Promise.resolve(true)
      const operation = previous.then(async () => {
        if (!canStartEditorSave(targetPath, conflictedPathsRef.current, migratingPathsRef.current)) return false
        const controller = new AbortController()
        writeControllersRef.current.set(targetPath, controller)
        try {
          await runTengriAction(
            { action: 'write-file', agentId: ownerAgentId, path: targetPath, content },
            controller.signal,
          )
          lastSavedRef.current.set(targetPath, content)
          if (disposedRef.current) return true
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
          const model = modelsRef.current.get(codeModelKey(ownerAgentId, targetPath))
          const unchanged = model?.getVersionId() === versionId && model.getValue() === content
          patchTab(targetPath, {
            dirty: !unchanged,
            state: unchanged ? 'ready' : 'saving',
            error: '',
          })
          return true
        } catch (cause) {
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
    [ownerAgentId, patchTab],
  )

  const scheduleSave = useCallback(
    (targetPath: string, model: TextModel) => {
      const currentTimer = saveTimersRef.current.get(targetPath)
      if (currentTimer) window.clearTimeout(currentTimer)
      if (!canStartEditorSave(targetPath, conflictedPathsRef.current, migratingPathsRef.current)) {
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
      const resolvingConflict = conflictedPathsRef.current.has(targetPath)
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
    [ownerAgentId, patchTab, savePath],
  )

  const flushActive = useCallback(() => {
    const targetPath = activePathRef.current
    if (targetPath) void flushPath(targetPath)
  }, [flushPath])

  const flushActiveRef = useRef(flushActive)
  const patchTabRef = useRef(patchTab)
  const scheduleSaveRef = useRef(scheduleSave)
  flushActiveRef.current = flushActive
  patchTabRef.current = patchTab
  scheduleSaveRef.current = scheduleSave

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
        patchTab(targetPath, { state: 'ready', error: '' })
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
        const result = await runTengriAction<{ content: string }>(
          { action: 'read-file', agentId: ownerAgentId, path: targetPath },
          controller.signal,
        )
        if (disposedRef.current || controller.signal.aborted || agentIdRef.current !== ownerAgentId) return
        const currentModel = modelsRef.current.get(modelKey)
        const currentTab = tabsRef.current.find((tab) => tab.path === targetPath)
        if (
          refresh &&
          (currentTab?.dirty || (initialVersionId !== undefined && currentModel?.getVersionId() !== initialVersionId))
        ) {
          markConflict(targetPath, 'File changed outside Code while local edits were pending.')
          return
        }
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
        lastSavedRef.current.set(targetPath, result.content)
        conflictedPathsRef.current.delete(targetPath)
        patchTab(targetPath, { dirty: false, state: 'ready', error: '' })
        if (activePathRef.current === targetPath) editor.setModel(model)
      } catch (cause) {
        if (controller.signal.aborted || agentIdRef.current !== ownerAgentId) return
        patchTab(targetPath, {
          state: 'error',
          error: cause instanceof Error ? cause.message : 'File could not be opened',
        })
      } finally {
        if (requestsRef.current.get(modelKey) === controller) requestsRef.current.delete(modelKey)
      }
    },
    [editorInstanceId, markConflict, ownerAgentId, patchTab, showPath],
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
          if (conflictedPathsRef.current.has(targetPath)) {
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
            patchTabRef.current(targetPath, { dirty: false, state: 'ready', error: '' })
            return
          }
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
      disposedRef.current = true
      for (const controller of requestsRef.current.values()) controller.abort()
      requestsRef.current.clear()
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
      migratingPathsRef.current.clear()
      editor?.dispose()
      editorRef.current = null
      disposeCodeModels(modelsRef.current)
      monacoRef.current = null
    }
  }, [])

  useEffect(() => {
    if (ownerAgentId === agentId) return
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
    for (const controller of writeControllersRef.current.values()) controller.abort()
    writeControllersRef.current.clear()
    pendingRequestsRef.current = []
    processedRequestsRef.current.clear()
    watchCursorsRef.current.clear()
    for (const timer of pendingRenameTimersRef.current.values()) window.clearTimeout(timer)
    pendingRenameTimersRef.current.clear()
    lastSavedRef.current.clear()
    writeEchoesRef.current.clear()
    conflictedPathsRef.current.clear()
    migratingPathsRef.current.clear()
    editorRef.current?.setModel(null)
    disposeCodeModels(modelsRef.current)
    tabsRef.current = []
    setTabs([])
    activePathRef.current = ''
    setActivePath('')
    setCursor({ line: 1, column: 1 })
    agentIdRef.current = agentId
    setOwnerAgentId(agentId)
    setOwnerWarning('')
  }, [agentId, ownerAgentId, tabs])

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
        const monaco = monacoRef.current
        let nextModel: TextModel | null = null
        if (previousModel && monaco) {
          const uri = monaco.Uri.from({
            scheme: 'tengri',
            authority: 'code',
            path,
            query: `agent=${encodeURIComponent(ownerAgentId)}&editor=${editorInstanceId}`,
          })
          nextModel = monaco.editor.createModel(previousModel.getValue(), codeLanguage(path), uri)
          modelsRef.current.delete(previousModelKey)
          modelsRef.current.set(nextModelKey, nextModel)
          previousModel.dispose()
        }

        const lastSaved = lastSavedRef.current.get(previousPath)
        lastSavedRef.current.delete(previousPath)
        if (lastSaved !== undefined) lastSavedRef.current.set(path, lastSaved)
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
    [clearPendingRename, editorInstanceId, loadPath, markConflict, ownerAgentId, updateTabs],
  )

  useEffect(() => {
    const directories = watchDirectoryKey ? watchDirectoryKey.split('\0') : []
    if (!directories.length) {
      setWatchState('connected')
      return
    }

    setWatchState('reconnecting')
    const connected = new Set<string>()
    const verifyChange = (targetPath: string) => {
      void runTengriAction<{ content: string }>({
        action: 'read-file',
        agentId: ownerAgentId,
        path: targetPath,
      })
        .then((result) => {
          const current = tabsRef.current.find((tab) => tab.path === targetPath)
          if (!current) return
          if (writeEchoesRef.current.matches(targetPath, result.content)) return
          if (current.dirty) markConflict(targetPath, 'File changed outside Code while local edits were pending.')
          else void loadPath(targetPath, true)
        })
        .catch((cause: unknown) =>
          markConflict(targetPath, cause instanceof Error ? cause.message : 'File change could not be verified'),
        )
    }
    const handleMessage = (directory: string, message: MessageEvent<string>) => {
      let event: TengriFileEvent
      try {
        event = JSON.parse(message.data) as TengriFileEvent
      } catch {
        return
      }
      watchCursorsRef.current.set(directory, Math.max(watchCursorsRef.current.get(directory) ?? 0, event.sequence))

      if (event.kind === 'reset') {
        for (const tab of tabsRef.current.filter((candidate) => codeParentDirectory(candidate.path) === directory)) {
          if (tab.dirty) markConflict(tab.path, 'Filesystem state changed while local edits were pending.')
          else void loadPath(tab.path, true)
        }
        return
      }

      const affected = tabsRef.current.find(
        (tab) => tab.path === event.path || (event.previousPath && tab.path === event.previousPath),
      )
      if (!affected) return
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
      const after = watchCursorsRef.current.get(directory) ?? 0
      const source = new EventSource(
        `/api/tengri/files/events?agentId=${encodeURIComponent(ownerAgentId)}&path=${encodeURIComponent(directory)}&after=${after}`,
      )
      source.onopen = () => {
        connected.add(directory)
        if (connected.size === directories.length) setWatchState('connected')
      }
      source.onerror = () => {
        connected.delete(directory)
        setWatchState('reconnecting')
      }
      source.onmessage = (message) => handleMessage(directory, message)
      return source
    })
    return () => {
      for (const source of sources) source.close()
    }
  }, [deferUnpairedRename, loadPath, markConflict, migratePath, ownerAgentId, watchDirectoryKey])

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
        {editorReady && activeTab?.state === 'error' ? (
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
            <button type="button" className="ml-1 text-[#79b8ff]" onClick={() => void flushPath(activeTab.path)}>
              Save mine
            </button>
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
