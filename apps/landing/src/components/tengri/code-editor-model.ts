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

export function isCodePath(value: string): boolean {
  return (
    value.startsWith('/') &&
    value.length <= 4_096 &&
    !value.includes('\0') &&
    !value.includes('\r') &&
    !value.includes('\n')
  )
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
