import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'

import { loadWorkflowLintConfig, type WorkflowLintFormat, type WorkflowLintMode } from './workflow-lint/config'
import { buildWorkflowLintGraph } from './workflow-lint/graph'
import { lintWorkflowModuleAst, type WorkflowLintViolation } from './workflow-lint/rules'

export type LintWorkflowsExitCode = 0 | 1

export type LintWorkflowsResult = {
  readonly exitCode: LintWorkflowsExitCode
  readonly mode: WorkflowLintMode
  readonly format: WorkflowLintFormat
  readonly entries: readonly string[]
  readonly violations: readonly WorkflowLintViolation[]
  readonly configSource?: string
}

class WorkflowLintCommandError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowLintCommandError'
  }
}

const truthy = new Set(['1', 'true', 't', 'yes', 'y', 'on'])

const readStringFlag = (value: string | boolean | undefined): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined

const readBooleanFlag = (value: string | boolean | undefined): boolean => {
  if (value === true) return true
  if (typeof value === 'string') return truthy.has(value.trim().toLowerCase())
  return false
}

const parseMode = (raw: string | undefined): WorkflowLintMode | undefined => {
  const normalized = raw?.trim().toLowerCase()
  if (!normalized) return undefined
  if (normalized === 'strict' || normalized === 'warn' || normalized === 'off') {
    return normalized
  }
  return undefined
}

const parseFormat = (raw: string | undefined): WorkflowLintFormat | undefined => {
  const normalized = raw?.trim().toLowerCase()
  if (!normalized) return undefined
  if (normalized === 'text' || normalized === 'json') {
    return normalized
  }
  return undefined
}

const splitRepeatable = (value: string | undefined): string[] => {
  if (!value) return []
  return value
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
}

const resolveDefaultMode = (env: NodeJS.ProcessEnv): WorkflowLintMode =>
  parseMode(env.TEMPORAL_WORKFLOW_LINT) ?? (readBooleanFlag(env.CI) ? 'strict' : 'warn')

const defaultDenyImports = new Set<string>([
  '@proompteng/temporal-bun-sdk/client',
  '@proompteng/temporal-bun-sdk/worker',
  'node:fs',
  'node:fs/promises',
  'node:net',
  'node:http',
  'node:https',
  'node:dgram',
  'node:tls',
  'node:child_process',
  'node:worker_threads',
  'fs',
  'net',
  'http',
  'https',
  'child_process',
  'worker_threads',
])

const defaultDenyGlobals = new Set<string>(['fetch', 'WebSocket', 'setTimeout', 'setInterval', 'Bun.spawn', 'Deno.run'])

const defaultDenyMemberExpressions = new Set<string>(['process.env', 'Bun.env'])

const expandWorkflowEntries = async (cwdPath: string, patterns: readonly string[]): Promise<string[]> => {
  const entries = new Set<string>()

  for (const pattern of patterns) {
    const resolved = resolve(cwdPath, pattern)
    if (existsSync(resolved)) {
      entries.add(resolved)
      continue
    }

    // Bun supports glob scanning natively.
    const glob = new Bun.Glob(pattern)
    for await (const match of glob.scan({ cwd: cwdPath, onlyFiles: true })) {
      entries.add(resolve(cwdPath, match))
    }
  }

  return [...entries].sort()
}

const listChangedFiles = async (cwdPath: string): Promise<Set<string>> => {
  const child = Bun.spawn(['git', 'diff', '--name-only', '--diff-filter=ACMRTUXB', 'origin/main...HEAD'], {
    cwd: cwdPath,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const text = await new Response(child.stdout).text()
  const files = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => resolve(cwdPath, line))
  return new Set(files)
}

export const executeLintWorkflows = async (options: {
  readonly cwd?: string
  readonly workflows?: readonly string[]
  readonly mode?: WorkflowLintMode
  readonly format?: WorkflowLintFormat
  readonly configPath?: string
  readonly changedOnly?: boolean
}): Promise<LintWorkflowsResult> => {
  // TODO(TBS-NDG-003): implement workflow lint CLI
  const cwdPath = options.cwd ?? process.cwd()
  const mode = options.mode ?? resolveDefaultMode(process.env)
  const format = options.format ?? 'text'

  if (mode === 'off') {
    return { exitCode: 0, mode, format, entries: [], violations: [] }
  }

  const { config, source } = await loadWorkflowLintConfig(cwdPath, options.configPath)
  const patterns = options.workflows && options.workflows.length > 0 ? options.workflows : (config?.entries ?? [])
  if (patterns.length === 0) {
    throw new WorkflowLintCommandError('No workflow entries provided. Use --workflows or .temporal-bun-workflows.json.')
  }

  const entries = await expandWorkflowEntries(cwdPath, patterns)
  if (entries.length === 0) {
    throw new WorkflowLintCommandError('No workflow entry files matched the configured patterns.')
  }

  const denyImports = new Set(defaultDenyImports)
  const denyGlobals = new Set(defaultDenyGlobals)
  const denyMemberExpressions = new Set(defaultDenyMemberExpressions)

  for (const item of config?.deny?.imports ?? []) denyImports.add(item)
  for (const item of config?.deny?.globals ?? []) denyGlobals.add(item)
  for (const item of config?.deny?.memberExpressions ?? []) denyMemberExpressions.add(item)

  for (const allowed of config?.allow?.imports ?? []) denyImports.delete(allowed)
  for (const allowed of config?.allow?.globals ?? []) denyGlobals.delete(allowed)
  for (const allowed of config?.allow?.memberExpressions ?? []) denyMemberExpressions.delete(allowed)

  const changedFiles = options.changedOnly ? await listChangedFiles(cwdPath) : undefined

  const violations: WorkflowLintViolation[] = []
  for (const entry of entries) {
    const { graph, violations: graphViolations } = await buildWorkflowLintGraph({
      entry,
      cwd: cwdPath,
      denyImports,
    })

    const modules = [...graph.modules].sort()
    if (changedFiles && !modules.some((file) => changedFiles.has(file))) {
      continue
    }

    for (const violation of graphViolations) {
      violations.push({
        filePath: violation.filePath,
        rule: violation.rule === 'dynamic-import' ? 'dynamic-import' : 'deny-import',
        message: violation.message,
        line: 1,
        column: 1,
        ...(violation.specifier ? { details: { specifier: violation.specifier } } : {}),
      })
    }

    for (const filePath of modules) {
      const fileViolations = await lintWorkflowModuleAst({
        filePath,
        denyGlobals,
        denyMemberExpressions,
        denyImports,
      })
      violations.push(...fileViolations)
    }
  }

  const exitCode: LintWorkflowsExitCode = violations.length > 0 && mode === 'strict' ? 1 : 0

  return {
    exitCode,
    mode,
    format,
    entries,
    violations,
    ...(source ? { configSource: source } : {}),
  }
}

export const printLintWorkflows = async (result: LintWorkflowsResult, options?: { outPath?: string }) => {
  const lines: string[] = []
  lines.push(`temporal-bun lint-workflows (${result.mode})`)
  if (result.configSource) {
    lines.push(`  config: ${result.configSource}`)
  }
  lines.push(`  entries: ${result.entries.length}`)
  lines.push(`  violations: ${result.violations.length}`)

  if (result.format === 'json') {
    const payload = JSON.stringify(result, null, 2)
    console.log(payload)
    if (options?.outPath) {
      await mkdir(dirname(options.outPath), { recursive: true })
      await writeFile(options.outPath, payload)
    }
    return
  }

  for (const line of lines) {
    console.log(line)
  }
  if (result.violations.length > 0) {
    const grouped = new Map<string, WorkflowLintViolation[]>()
    for (const violation of result.violations) {
      const list = grouped.get(violation.filePath) ?? []
      list.push(violation)
      grouped.set(violation.filePath, list)
    }

    for (const [filePath, fileViolations] of grouped) {
      console.log(`\n${filePath}`)
      for (const v of fileViolations) {
        console.log(`  ${v.line}:${v.column} ${v.rule} ${v.message}`)
      }
    }
  }
}

export const parseLintWorkflowsFlags = (flags: Record<string, string | boolean>) => {
  const workflows = [
    ...splitRepeatable(readStringFlag(flags.workflows)),
    ...splitRepeatable(readStringFlag(flags.workflow)),
    ...splitRepeatable(readStringFlag(flags.entries)),
  ]

  const workflowsFromRepeatable = [
    readStringFlag(flags['workflows-0']),
    readStringFlag(flags['workflows-1']),
    readStringFlag(flags['workflows-2']),
  ].filter(Boolean) as string[]

  const mode = parseMode(readStringFlag(flags.mode))
  const format = parseFormat(readStringFlag(flags.format))
  const configPath = readStringFlag(flags.config)
  const changedOnly = readBooleanFlag(flags['changed-only'])

  return {
    workflows: [...workflows, ...workflowsFromRepeatable],
    mode,
    format,
    configPath,
    changedOnly,
  }
}

// Used by tests for isolated temp workspace runs.
export const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const root = await mkdtemp(resolve(tmpdir(), 'temporal-bun-lint-'))
  await mkdir(root, { recursive: true })
  return await fn(root)
}
