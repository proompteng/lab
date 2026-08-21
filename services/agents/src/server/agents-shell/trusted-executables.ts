import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'

import { isInsidePath } from './workspace-policy'

export type TrustedExecutableName = 'apply_patch' | 'bash' | 'git' | 'kubectl' | 'landlock' | 'rg'

export type TrustedExecutables = {
  paths: string[]
  executables: Record<TrustedExecutableName, string | null>
}

const assertTrustedPath = (workspaceRoot: string, unresolved: string) => {
  const path = realpathSync(isAbsolute(unresolved) ? unresolved : resolve(unresolved))
  const stat = statSync(path)
  if (!stat.isDirectory()) throw new Error(`trusted PATH entry is not a directory: ${path}`)
  const startupUid = process.geteuid?.() ?? stat.uid
  if (stat.uid !== 0 && stat.uid !== startupUid) {
    throw new Error(`trusted PATH entry must be owned by root or the startup UID: ${path}`)
  }
  if ((stat.mode & 0o022) !== 0) throw new Error(`trusted PATH entry must not be group/world writable: ${path}`)
  if (isInsidePath(resolve(workspaceRoot), path)) {
    throw new Error(`trusted PATH entry must stay outside the user workspace: ${path}`)
  }
  return path
}

const pinTrustedPath = (workspaceRoot: string, pathValue: string | undefined) =>
  Array.from(
    new Set(
      (pathValue ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((path) => assertTrustedPath(workspaceRoot, path)),
    ),
  )

const findOnPath = (name: string, paths: readonly string[]) => {
  for (const directory of paths) {
    const candidate = join(directory, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue to the next startup-pinned PATH entry.
    }
  }
  return null
}

const pinExecutable = (
  workspaceRoot: string,
  paths: readonly string[],
  configured: string | undefined,
  fallbackName: string,
) => {
  const unresolved = configured ?? findOnPath(fallbackName, paths)
  if (!unresolved) return null
  const path = realpathSync(isAbsolute(unresolved) ? unresolved : resolve(unresolved))
  const stat = statSync(path)
  if (!stat.isFile()) throw new Error(`trusted executable is not a file: ${path}`)
  const startupUid = process.geteuid?.() ?? stat.uid
  if (stat.uid !== 0 && stat.uid !== startupUid) {
    throw new Error(`trusted executable must be owned by root or the startup UID: ${path}`)
  }
  if ((stat.mode & 0o022) !== 0) throw new Error(`trusted executable must not be group/world writable: ${path}`)
  if (isInsidePath(resolve(workspaceRoot), path)) {
    throw new Error(`trusted executable must stay outside the user workspace: ${path}`)
  }
  accessSync(path, constants.X_OK)
  return path
}

export const pinTrustedExecutables = (workspaceRoot: string, env: NodeJS.ProcessEnv): TrustedExecutables => {
  const paths = pinTrustedPath(workspaceRoot, env.AGENTS_SHELL_TRUSTED_PATH ?? env.PATH)
  return {
    paths,
    executables: {
      apply_patch: pinExecutable(workspaceRoot, paths, env.AGENTS_SHELL_APPLY_PATCH_EXECUTABLE, 'apply_patch'),
      bash: pinExecutable(workspaceRoot, paths, env.AGENTS_SHELL_BASH_EXECUTABLE, 'bash'),
      git: pinExecutable(workspaceRoot, paths, env.AGENTS_SHELL_GIT_EXECUTABLE, 'git'),
      kubectl: pinExecutable(workspaceRoot, paths, env.AGENTS_SHELL_KUBECTL_EXECUTABLE, 'kubectl'),
      landlock: pinExecutable(workspaceRoot, paths, env.AGENTS_SHELL_LANDLOCK_EXECUTABLE, 'agents-shell-landlock'),
      rg: pinExecutable(workspaceRoot, paths, env.AGENTS_SHELL_RG_EXECUTABLE, 'rg'),
    },
  }
}

export const trustedExecutablePath = (trusted: TrustedExecutables, name: TrustedExecutableName) => {
  const executable = trusted.executables[name]
  if (!executable) throw new Error(`required trusted executable is unavailable: ${name}`)
  return executable
}

export const trustedPathValue = (trusted: TrustedExecutables) =>
  Array.from(
    new Set([
      ...trusted.paths,
      ...Object.values(trusted.executables)
        .filter((value): value is string => value != null)
        .map(dirname),
    ]),
  ).join(delimiter)
