import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

export const isInsidePath = (root: string, candidate: string) => {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export const resolveWorkspacePath = (workspaceRoot: string, inputPath?: string | null) => {
  const root = resolve(workspaceRoot)
  const candidate = inputPath ? resolve(root, inputPath) : root
  if (!isInsidePath(root, candidate)) {
    throw new Error(`path must stay under ${root}`)
  }
  return candidate
}

export const resolveExistingDirectory = (workspaceRoot: string, cwd?: string | null) => {
  const candidate = resolveWorkspacePath(workspaceRoot, cwd)
  if (!existsSync(candidate)) throw new Error(`cwd does not exist: ${candidate}`)
  return candidate
}
