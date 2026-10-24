import { isCodePath } from './code-editor-model'

export type WorkspaceFileTarget = NonNullable<ReturnType<typeof parseWorkspaceFileLink>>

export function parseWorkspaceFileLink(
  href: string,
  basePath?: string,
): { path: string; line?: number; column?: number } | null {
  if (
    basePath &&
    !href.startsWith('/') &&
    !href.startsWith('#') &&
    (!/^[a-z][a-z0-9+.-]*:/i.test(href) || /^[^/]+\.[^/:]+:\d+(?::\d+)?$/.test(href))
  ) {
    try {
      const relative = new URL(`./${href}`, `https://workspace.invalid${basePath}`)
      href = relative.pathname + relative.search + relative.hash
    } catch {
      return null
    }
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(href)
  } catch {
    return null
  }
  const match = /^(.*?)(?::([0-9]+)(?::([0-9]+))?|#L([0-9]+)(?:C([0-9]+))?)?$/.exec(decoded)
  if (!match) return null
  const absolute = match[1]
  if (absolute !== '/workspace' && !absolute.startsWith('/workspace/')) return null
  const path = absolute.replace(/\/+$/, '')
  if (!isCodePath(path) || /[?#\\]/.test(path) || path.split('/').some((part) => part === '..' || part === '.'))
    return null
  const lineText = match[2] ?? match[4]
  const columnText = match[3] ?? match[5]
  const line = lineText === undefined ? undefined : Number(lineText)
  const column = columnText === undefined ? undefined : Number(columnText)
  if ([line, column].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 1))) return null
  return { path, line, column }
}
