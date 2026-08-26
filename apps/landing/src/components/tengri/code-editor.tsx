'use client'

import { CircleAlert, FileCode2, LoaderCircle, X } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'

import { runTengriAction } from './client'
import {
  closeEditorTab,
  codeFileName,
  codeLanguage,
  codeModelKey,
  codeModelTransition,
  codeOpenRequestKey,
  codePanelId,
  disposeCodeModels,
  enqueueCodeOpenRequest,
  isCodePath,
  openEditorTab,
  type CodeOpenRequest,
  type EditorTab,
} from './code-editor-model'

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

export function CodeEditor({ agentId, request }: { agentId: string; request: CodeOpenRequest | null }) {
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
  const disposedRef = useRef(false)
  const [tabs, setTabs] = useState<EditorTab[]>([])
  const [activePath, setActivePath] = useState('')
  const [cursor, setCursor] = useState({ line: 1, column: 1 })
  const [editorReady, setEditorReady] = useState(false)
  const [editorError, setEditorError] = useState('')

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

  const showPath = useCallback(
    (targetPath: string, refresh = false) => {
      const editor = editorRef.current
      if (!editor) return false
      const transition = codeModelTransition(
        activePathRef.current,
        targetPath,
        modelsRef.current.get(codeModelKey(agentId, targetPath)),
        refresh,
      )
      if (transition.type === 'detach') editor.setModel(null)
      if (transition.type !== 'show' && transition.type !== 'refresh') return false
      activePathRef.current = targetPath
      setActivePath(targetPath)
      editor.setModel(transition.model)
      return transition.type === 'show'
    },
    [agentId],
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

      const modelKey = codeModelKey(agentId, targetPath)
      const cachedModel = modelsRef.current.get(modelKey)
      requestsRef.current.get(modelKey)?.abort()
      const controller = new AbortController()
      requestsRef.current.set(modelKey, controller)
      patchTab(targetPath, { state: 'loading', error: '' })
      try {
        const result = await runTengriAction<{ content: string }>(
          { action: 'read-file', agentId, path: targetPath },
          controller.signal,
        )
        if (disposedRef.current || controller.signal.aborted || agentIdRef.current !== agentId) return
        const uri = monaco.Uri.from({
          scheme: 'tengri',
          authority: 'code',
          path: targetPath,
          query: `agent=${encodeURIComponent(agentId)}&editor=${editorInstanceId}`,
        })
        let model = cachedModel
        if (!model || model.isDisposed())
          model = monaco.editor.createModel(result.content, codeLanguage(targetPath), uri)
        else model.setValue(result.content)
        modelsRef.current.set(modelKey, model)
        patchTab(targetPath, { state: 'ready', error: '' })
        if (activePathRef.current === targetPath) editor.setModel(model)
      } catch (cause) {
        if (controller.signal.aborted || agentIdRef.current !== agentId) return
        patchTab(targetPath, {
          state: 'error',
          error: cause instanceof Error ? cause.message : 'File could not be opened',
        })
      } finally {
        if (requestsRef.current.get(modelKey) === controller) requestsRef.current.delete(modelKey)
      }
    },
    [agentId, editorInstanceId, patchTab, showPath],
  )

  useEffect(() => {
    disposedRef.current = false
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
          domReadOnly: true,
          fontFamily: 'JetBrains Mono, SFMono-Regular, Menlo, monospace',
          fontLigatures: true,
          fontSize: 13,
          lineHeight: 21,
          minimap: { enabled: false },
          padding: { top: 14, bottom: 14 },
          readOnly: true,
          readOnlyMessage: { value: 'Editing will be enabled when Tengri persistence is connected.' },
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
      editor?.dispose()
      editorRef.current = null
      disposeCodeModels(modelsRef.current)
      monacoRef.current = null
    }
  }, [])

  useEffect(() => {
    if (agentIdRef.current === agentId) return
    agentIdRef.current = agentId
    for (const controller of requestsRef.current.values()) controller.abort()
    requestsRef.current.clear()
    pendingRequestsRef.current = []
    processedRequestsRef.current.clear()
    editorRef.current?.setModel(null)
    disposeCodeModels(modelsRef.current)
    tabsRef.current = []
    setTabs([])
    activePathRef.current = ''
    setActivePath('')
    setCursor({ line: 1, column: 1 })
  }, [agentId])

  const requestPath = request?.path ?? ''
  const requestId = request?.requestId ?? -1
  useEffect(() => {
    if (requestId < 0 || !isCodePath(requestPath)) return
    const nextRequest = { path: requestPath, requestId }
    const requestKey = codeOpenRequestKey(nextRequest)
    if (processedRequestsRef.current.has(requestKey)) return
    processedRequestsRef.current.add(requestKey)
    updateTabs((current) => openEditorTab(current, requestPath))
    activePathRef.current = requestPath
    setActivePath(requestPath)
    if (!editorReady) {
      pendingRequestsRef.current = enqueueCodeOpenRequest(pendingRequestsRef.current, nextRequest)
      return
    }
    void loadPath(requestPath, true)
  }, [editorReady, loadPath, requestId, requestPath, updateTabs])

  useEffect(() => {
    if (!editorReady || pendingRequestsRef.current.length === 0) return
    const pendingRequests = pendingRequestsRef.current
    pendingRequestsRef.current = []
    for (const pendingRequest of pendingRequests) void loadPath(pendingRequest.path, true)
  }, [editorReady, loadPath])

  function activateTab(targetPath: string) {
    activePathRef.current = targetPath
    setActivePath(targetPath)
    if (!showPath(targetPath)) void loadPath(targetPath)
  }

  function closeTab(targetPath: string) {
    const modelKey = codeModelKey(agentId, targetPath)
    requestsRef.current.get(modelKey)?.abort()
    requestsRef.current.delete(modelKey)
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
                {tab.state === 'loading' ? (
                  <LoaderCircle className="h-3 w-3 animate-spin" aria-label="Loading" />
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
          {activeTab?.state === 'loading' ? <LoaderCircle className="h-3 w-3 animate-spin" /> : null}
          {activeTab?.state === 'error' ? <CircleAlert className="h-3 w-3 text-red-300" /> : null}
          <span className={activeTab?.state === 'error' ? 'max-w-64 truncate text-red-300' : ''}>
            {activeTab?.error || activeTab?.state || 'idle'}
          </span>
          {activeTab?.state === 'error' ? (
            <button type="button" className="ml-1 text-[#79b8ff]" onClick={() => void loadPath(activeTab.path, true)}>
              Retry
            </button>
          ) : null}
        </span>
        <span className="ml-4">Read only</span>
      </div>
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
