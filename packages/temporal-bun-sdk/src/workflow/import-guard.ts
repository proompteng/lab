import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { dirname, extname, resolve } from 'node:path'

import type { WorkflowImportPolicy } from '../config'

const CANDIDATE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'] as const
const BUILTIN_SPECIFIERS = new Set<string>([...builtinModules, ...builtinModules.map((mod) => `node:${mod}`), 'bun'])
const BUN_SPECIFIERS = ['bun:ffi', 'bun:sqlite', 'bun:jsc', 'bun:net', 'bun:wrap', 'bun:macro']
const LOADER_BY_EXTENSION: Record<string, LoaderType> = {
  '.ts': 'ts',
  '.cts': 'ts',
  '.mts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.cjs': 'js',
  '.mjs': 'js',
  '.jsx': 'jsx',
}

export type WorkflowImportGuardReason = 'blocked' | 'not-allowed'

export interface WorkflowImportGuardViolation {
  readonly specifier: string
  readonly importers: readonly string[]
  readonly reason: WorkflowImportGuardReason
}

export class WorkflowImportGuardError extends Error {
  constructor(
    readonly violations: readonly WorkflowImportGuardViolation[],
    readonly policy: WorkflowImportPolicy,
  ) {
    super(buildErrorMessage(violations))
    this.name = 'WorkflowImportGuardError'
  }
}

type LoaderType = 'js' | 'jsx' | 'ts' | 'tsx'

const getTranspiler = (() => {
  const cache = new Map<LoaderType, Bun.Transpiler>()
  return (loader: LoaderType): Bun.Transpiler => {
    const cached = cache.get(loader)
    if (cached) return cached
    const created = new Bun.Transpiler({ loader })
    cache.set(loader, created)
    return created
  }
})()

const loaderForFile = (filePath: string): LoaderType => LOADER_BY_EXTENSION[extname(filePath).toLowerCase()] ?? 'js'

const isRelativeOrAbsolute = (specifier: string): boolean => specifier.startsWith('.') || specifier.startsWith('/')

const normalizeBuiltInSpecifier = (specifier: string): string => {
  if (specifier.startsWith('node:')) {
    return specifier.slice('node:'.length)
  }
  return specifier
}

const isBuiltInSpecifier = (specifier: string): boolean => {
  if (specifier.startsWith('bun:')) return true
  if (BUN_SPECIFIERS.includes(specifier)) return true
  return BUILTIN_SPECIFIERS.has(specifier)
}

const resolveImportPath = (specifier: string, importer: string): string | undefined => {
  if (!isRelativeOrAbsolute(specifier)) return undefined
  const basePath = specifier.startsWith('/') ? specifier : resolve(dirname(importer), specifier)
  if (existsSync(basePath) && !isDirectory(basePath)) {
    return basePath
  }

  for (const extension of CANDIDATE_EXTENSIONS) {
    const candidate = `${basePath}${basePath.endsWith(extension) ? '' : extension}`
    if (existsSync(candidate) && !isDirectory(candidate)) {
      return candidate
    }
  }

  for (const extension of CANDIDATE_EXTENSIONS) {
    const candidate = resolve(basePath, `index${extension}`)
    if (existsSync(candidate) && !isDirectory(candidate)) {
      return candidate
    }
  }
  return undefined
}

const isDirectory = (path: string): boolean => {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

const scanImports = async (filePath: string): Promise<string[]> => {
  const source = await readFile(filePath, 'utf8')
  const imports = getTranspiler(loaderForFile(filePath)).scanImports(source)
  return imports.map((entry) => entry.path)
}

const recordViolation = (
  violations: Map<string, WorkflowImportGuardViolation>,
  specifier: string,
  importer: string,
  reason: WorkflowImportGuardReason,
) => {
  const existing = violations.get(specifier)
  if (existing) {
    violations.set(specifier, {
      ...existing,
      importers: [...existing.importers, importer],
    })
    return
  }
  violations.set(specifier, { specifier, importers: [importer], reason })
}

export const assertWorkflowImportsDeterministic = async (
  entryPath: string,
  policy: WorkflowImportPolicy,
): Promise<void> => {
  if (!entryPath) {
    throw new WorkflowImportGuardError(
      [
        {
          specifier: '(entrypoint missing)',
          importers: [],
          reason: 'not-allowed',
        },
      ],
      policy,
    )
  }

  const violations = new Map<string, WorkflowImportGuardViolation>()
  const visited = new Set<string>()
  const resolvedEntry = resolve(entryPath)
  if (!existsSync(resolvedEntry)) {
    throw new WorkflowImportGuardError(
      [
        {
          specifier: resolvedEntry,
          importers: [],
          reason: 'not-allowed',
        },
      ],
      policy,
    )
  }
  const stack = [resolvedEntry]

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || visited.has(current)) {
      continue
    }
    visited.add(current)

    if (!existsSync(current)) {
      continue
    }

    const imports = await scanImports(current)

    for (const specifier of imports) {
      if (policy.unsafeAllow) {
        continue
      }

      if (isBuiltInSpecifier(specifier)) {
        const normalized = normalizeBuiltInSpecifier(specifier)
        if (policy.ignore.includes(normalized)) {
          continue
        }
        if (policy.allow.includes(normalized)) {
          continue
        }
        if (policy.block.includes(normalized)) {
          recordViolation(violations, normalized, current, 'blocked')
          continue
        }
        recordViolation(violations, normalized, current, 'not-allowed')
        continue
      }

      const resolved = resolveImportPath(specifier, current)
      if (resolved) {
        stack.push(resolved)
      }
    }
  }

  if (violations.size > 0) {
    throw new WorkflowImportGuardError([...violations.values()], policy)
  }
}

const buildErrorMessage = (violations: readonly WorkflowImportGuardViolation[]): string => {
  const summary = violations
    .map((violation) => {
      const locations = violation.importers.length ? ` (imported from ${violation.importers.join(', ')})` : ''
      const reason = violation.reason === 'blocked' ? 'blocked' : 'not allowed'
      return `- ${violation.specifier}${locations} [${reason}]`
    })
    .join('\n')

  const guidance =
    'Remove nondeterministic built-in imports or allow specific modules via TEMPORAL_WORKFLOW_IMPORT_ALLOW (comma-separated). ' +
    'Set TEMPORAL_WORKFLOW_IMPORT_UNSAFE_OK=1 only when debugging to bypass this guard temporarily.'

  return `Workflow import guard failed:\n${summary}\n${guidance}`
}

export const normalizeWorkflowImportPolicy = (policy: WorkflowImportPolicy): WorkflowImportPolicy => ({
  allow: [...policy.allow],
  block: [...policy.block],
  ignore: [...policy.ignore],
  unsafeAllow: policy.unsafeAllow,
})
