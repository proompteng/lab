import { MAX_CODE_WATCH_DIRECTORIES } from '@/lib/tengri/limits'

export type CodeOpenRequest = {
  path: string
  requestId: number
}

export type EditorTab = {
  path: string
  dirty: boolean
  state: 'error' | 'loading' | 'ready' | 'saving'
  error: string
}

export type CodeModelTransition<Model> =
  | { type: 'detach' }
  | { type: 'refresh'; model: Model }
  | { type: 'show'; model: Model }
  | { type: 'unchanged' }

export function isCodePath(value: string): boolean {
  return (
    value.startsWith('/') &&
    value.length <= 4_096 &&
    !value.includes('\0') &&
    !value.includes('\r') &&
    !value.includes('\n')
  )
}

export function codeModelKey(agentId: string, path: string): string {
  return `${agentId}\0${path}`
}

export function codePanelId(instanceId: string): string {
  return `tengri-code-panel-${instanceId}`
}

export function codeOpenRequestKey(request: CodeOpenRequest): string {
  return `${request.requestId}:${request.path}`
}

export function enqueueCodeOpenRequest(queue: CodeOpenRequest[], request: CodeOpenRequest): CodeOpenRequest[] {
  if (!Number.isSafeInteger(request.requestId) || request.requestId < 0 || !isCodePath(request.path)) return queue
  const requestKey = codeOpenRequestKey(request)
  return queue.some((candidate) => codeOpenRequestKey(candidate) === requestKey) ? queue : [...queue, request]
}

export function codeModelTransition<Model>(
  activePath: string,
  targetPath: string,
  cachedModel: Model | undefined,
  refresh = false,
): CodeModelTransition<Model> {
  if (cachedModel) return { type: refresh ? 'refresh' : 'show', model: cachedModel }
  return activePath === targetPath ? { type: 'detach' } : { type: 'unchanged' }
}

export function disposeCodeModels<Model extends { dispose: () => void }>(models: Map<string, Model>): void {
  for (const model of models.values()) model.dispose()
  models.clear()
}

export function openEditorTab(tabs: EditorTab[], path: string): EditorTab[] {
  if (!isCodePath(path) || tabs.some((tab) => tab.path === path)) return tabs
  return [...tabs, { path, dirty: false, state: 'loading', error: '' }]
}

export function closeEditorTab(
  tabs: readonly EditorTab[],
  activePath: string,
  closingPath: string,
): { tabs: EditorTab[]; activePath: string } {
  const index = tabs.findIndex((tab) => tab.path === closingPath)
  if (index < 0) return { tabs: [...tabs], activePath }
  const nextTabs = tabs.filter((tab) => tab.path !== closingPath)
  if (activePath !== closingPath) return { tabs: nextTabs, activePath }
  return { tabs: nextTabs, activePath: nextTabs[Math.min(index, nextTabs.length - 1)]?.path ?? '' }
}

export function renameEditorTab(
  tabs: readonly EditorTab[],
  activePath: string,
  previousPath: string,
  path: string,
): { tabs: EditorTab[]; activePath: string } {
  if (!isCodePath(path) || tabs.some((tab) => tab.path === path)) return { tabs: [...tabs], activePath }
  return {
    tabs: tabs.map((tab) => (tab.path === previousPath ? { ...tab, path } : tab)),
    activePath: activePath === previousPath ? path : activePath,
  }
}

export function codeParentDirectory(path: string): string {
  const separator = path.lastIndexOf('/')
  return separator <= 0 ? '/' : path.slice(0, separator)
}

export function isEditorValuePersisted(value: string, lastSaved: string | undefined, savePending: boolean): boolean {
  return lastSaved !== undefined && value === lastSaved && !savePending
}

export function canStartEditorSave(
  path: string,
  conflictedPaths: ReadonlySet<string>,
  migratingPaths: ReadonlySet<string>,
): boolean {
  return !conflictedPaths.has(path) && !migratingPaths.has(path)
}

export function codeWatchDirectoryLimitError(): string {
  return `Code can watch files in at most ${MAX_CODE_WATCH_DIRECTORIES} directories at once. Close a tab before opening this file.`
}

export function clearCodeWatchDirectoryLimitError(error: string): string {
  return error === codeWatchDirectoryLimitError() ? '' : error
}

export function codeFileName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) || path
}

export function codeLanguage(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase()
  return (
    {
      css: 'css',
      go: 'go',
      html: 'html',
      js: 'javascript',
      json: 'json',
      jsx: 'javascript',
      md: 'markdown',
      py: 'python',
      rs: 'rust',
      sh: 'shell',
      toml: 'toml',
      ts: 'typescript',
      tsx: 'typescript',
      yaml: 'yaml',
      yml: 'yaml',
    }[extension || ''] || 'plaintext'
  )
}
