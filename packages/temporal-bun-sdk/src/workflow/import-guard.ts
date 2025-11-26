import { builtinModules } from 'node:module'
import path from 'node:path'

import type { WorkflowImportPolicy } from '../config'

const normalizeSpecifier = (specifier: string): string =>
  specifier
    .replace(/^node:/, '')
    .replace(/^bun:/, '')
    .trim()

const BUN_BUILTINS = ['bun', 'bun:ffi', 'bun:sqlite', 'bun:sqlite3', 'bun:jsc']
const BUILTIN_SET = new Set<string>([...builtinModules, ...BUN_BUILTINS].map(normalizeSpecifier))

const transpilers = new Map<Bun.Transpiler['loader'], Bun.Transpiler>()

const getTranspiler = (loader: Bun.Transpiler['loader']): Bun.Transpiler => {
  const cached = transpilers.get(loader)
  if (cached) {
    return cached
  }
  const created = new Bun.Transpiler({ loader })
  transpilers.set(loader, created)
  return created
}

const resolveLoader = (filePath: string): Bun.Transpiler['loader'] => {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.tsx') return 'tsx'
  if (ext === '.jsx') return 'jsx'
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') return 'ts'
  return 'js'
}

const matchesPolicy = (specifier: string, entries: readonly string[]): boolean => {
  if (!entries.length) return false
  const base = specifier.split('/')[0] ?? specifier
  return entries.some((entry) => {
    const normalized = normalizeSpecifier(entry)
    return normalized === base || specifier === normalized || specifier.startsWith(`${normalized}/`)
  })
}

const isBuiltinSpecifier = (specifier: string): boolean =>
  BUILTIN_SET.has(normalizeSpecifier(specifier).split('/')[0] ?? '')

const resolveImport = (specifier: string, fromFile: string): { builtin?: string; path?: string } | undefined => {
  try {
    const resolved = Bun.resolveSync(specifier, path.dirname(fromFile))
    if (resolved.startsWith('node:') || resolved.startsWith('bun:')) {
      return { builtin: resolved }
    }
    return { path: path.resolve(resolved) }
  } catch {
    return undefined
  }
}

const scanImports = async (filePath: string): Promise<{ path: string }[]> => {
  const file = Bun.file(filePath)
  if (!(await file.exists())) {
    return []
  }
  const source = await file.text()
  const loader = resolveLoader(filePath)
  const transpiler = getTranspiler(loader)
  return transpiler.scanImports(source)
}

export class WorkflowImportGuardError extends Error {
  constructor(
    message: string,
    readonly specifiers: string[],
  ) {
    super(message)
    this.name = 'WorkflowImportGuardError'
  }
}

export const guardWorkflowImports = async (entrypoint: string, policy: WorkflowImportPolicy): Promise<void> => {
  if (policy.unsafeImportsAllowed) {
    return
  }

  const visited = new Set<string>()
  const queue = [path.resolve(entrypoint)]
  const violations = new Set<string>()

  while (queue.length > 0) {
    const current = queue.pop()
    if (!current || visited.has(current)) {
      continue
    }
    visited.add(current)

    const imports = await scanImports(current)

    for (const record of imports) {
      const rawSpecifier = record.path
      const normalized = normalizeSpecifier(rawSpecifier)
      const builtin = isBuiltinSpecifier(rawSpecifier)
      const ignored = matchesPolicy(normalized, policy.ignore)
      if (ignored) {
        continue
      }
      const allowed = matchesPolicy(normalized, policy.allow)
      const blocked = matchesPolicy(normalized, policy.block)

      if (!allowed && (blocked || builtin)) {
        violations.add(normalized || rawSpecifier)
        continue
      }

      const resolved = resolveImport(rawSpecifier, current)
      if (!resolved) {
        continue
      }
      if (resolved.builtin) {
        const builtinSpecifier = normalizeSpecifier(resolved.builtin)
        const builtinAllowed = matchesPolicy(builtinSpecifier, policy.allow)
        const builtinIgnored = matchesPolicy(builtinSpecifier, policy.ignore)
        const builtinBlocked = matchesPolicy(builtinSpecifier, policy.block)
        if (!builtinIgnored && !builtinAllowed && (builtinBlocked || isBuiltinSpecifier(builtinSpecifier))) {
          violations.add(builtinSpecifier)
        }
        continue
      }

      if (resolved.path) {
        queue.push(resolved.path)
      }
    }
  }

  if (violations.size > 0) {
    const specifiers = [...violations].sort()
    const hints = [
      'Remove nondeterministic built-in imports from workflows or move them to activities.',
      'Allow a module explicitly via TEMPORAL_WORKFLOW_IMPORT_ALLOW or ignore it with TEMPORAL_WORKFLOW_IMPORT_IGNORE.',
      'For debugging only, TEMPORAL_WORKFLOW_IMPORT_UNSAFE_OK=1 skips the guard.',
    ]
    const message = `Workflow import guard blocked nondeterministic modules: ${specifiers.join(', ')}. ${hints.join(' ')}`
    throw new WorkflowImportGuardError(message, specifiers)
  }
}
