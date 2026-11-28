import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { matchesGlob } from './impact-router'

export type InputTarget = { paths: string[]; workspaces: string[]; watchPlannerAction?: boolean }

const plannerAction = '.github/actions/affected-inputs/**'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const record = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error('Expected an object in CI input metadata')
  return value
}

const strings = (value: unknown): string[] => {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new Error('Expected a string list in CI input metadata')
  }
  return value
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    isRecord(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item,
  )

type LockNode = { id: string; context: string; value: unknown; metadata: Record<string, unknown> }

class LockGraph {
  readonly workspaces: Record<string, unknown>
  readonly packages: Record<string, unknown>
  readonly settings: string

  constructor(value: unknown) {
    const lock = record(value)
    if (lock.lockfileVersion !== 1) throw new Error(`Unsupported Bun lockfile version: ${lock.lockfileVersion}`)
    this.workspaces = record(lock.workspaces)
    this.packages = record(lock.packages)
    this.settings = canonical(
      Object.fromEntries(Object.entries(lock).filter(([key]) => !['workspaces', 'packages'].includes(key))),
    )
  }

  workspace(path: string): LockNode {
    const metadata = record(this.workspaces[path])
    if (typeof metadata.name !== 'string') throw new Error(`Missing workspace name: ${path}`)
    return { id: `workspace:${path}`, context: metadata.name, value: metadata, metadata }
  }

  resolve(name: string, context: string): LockNode | undefined {
    for (;;) {
      const key = context ? `${context}/${name}` : name
      const value = this.packages[key]
      if (value !== undefined) {
        if (!Array.isArray(value) || typeof value[0] !== 'string') throw new Error(`Invalid package: ${key}`)
        const workspacePath = value[0].split('@workspace:')[1]
        if (workspacePath !== undefined) return this.workspace(workspacePath)
        const metadata = value.find(isRecord)
        if (!metadata) throw new Error(`Missing package metadata: ${key}`)
        return { id: `package:${key}`, context: key, value, metadata }
      }
      if (!context) return undefined
      context = context.replace(/(?:^|\/)(?:@[^/]+\/)?[^/]+$/, '')
    }
  }

  dependencies(node: LockNode): Map<string, LockNode | undefined> {
    const result = new Map<string, LockNode | undefined>()
    const fields = ['dependencies', 'optionalDependencies', 'peerDependencies']
    if (node.id.startsWith('workspace:')) fields.push('devDependencies')
    for (const field of fields) {
      for (const [name, range] of Object.entries(record(node.metadata[field] ?? {}))) {
        if (typeof range !== 'string') throw new Error(`Invalid dependency: ${node.id} ${name}`)
        const dependency = this.resolve(name, node.context)
        if (!dependency && field !== 'peerDependencies') throw new Error(`Unresolved dependency: ${node.id} ${name}`)
        result.set(name, dependency)
      }
    }
    return new Map([...result].sort(([a], [b]) => a.localeCompare(b)))
  }

  workspaceClosure(paths: string[]): Set<string> {
    const workspaces = new Set<string>()
    const visited = new Set<string>()
    const queue = paths.map((path) => this.workspace(path))
    for (const node of queue) {
      if (visited.has(node.id)) continue
      visited.add(node.id)
      if (node.id.startsWith('workspace:')) workspaces.add(node.id.slice('workspace:'.length))
      for (const dependency of this.dependencies(node).values()) if (dependency) queue.push(dependency)
    }
    return workspaces
  }
}

const equalDependencies = (before: LockGraph, after: LockGraph, paths: string[]): boolean => {
  if (before.settings !== after.settings) return false
  const visited = new Set<string>()
  const equal = (left: LockNode | undefined, right: LockNode | undefined): boolean => {
    if (!left || !right) return left === right
    const pair = JSON.stringify([left.id, right.id])
    if (visited.has(pair)) return true
    visited.add(pair)
    if (canonical(left.value) !== canonical(right.value)) return false
    const leftDependencies = before.dependencies(left)
    const rightDependencies = after.dependencies(right)
    return (
      leftDependencies.size === rightDependencies.size &&
      [...leftDependencies].every(
        ([name, dependency]) => rightDependencies.has(name) && equal(dependency, rightDependencies.get(name)),
      )
    )
  }
  return paths.every((path) => equal(before.workspace(path), after.workspace(path)))
}

export const matchesPaths = (file: string, patterns: string[]): boolean =>
  patterns.reduce((matched, pattern) => {
    const negative = pattern.startsWith('!')
    return matchesGlob(file, negative ? pattern.slice(1) : pattern) ? !negative : matched
  }, false)

export const matchesOnlyPaths = (files: string[], patterns: string[]): boolean =>
  files.length > 0 && files.every((file) => matchesPaths(file, patterns))

export const selectAffectedInputs = (
  files: string[],
  targets: Record<string, InputTarget>,
  beforeValue: unknown,
  afterValue: unknown,
): Record<string, boolean> => {
  const before = new LockGraph(beforeValue)
  const after = new LockGraph(afterValue)
  return Object.fromEntries(
    Object.entries(targets).map(([name, target]) => {
      if (target.workspaces.some((path) => !(path in before.workspaces) || !(path in after.workspaces)))
        return [name, true]
      const owned = new Set([
        ...before.workspaceClosure(target.workspaces),
        ...after.workspaceClosure(target.workspaces),
      ])
      const changed = files.some((file) => {
        // Scripts CI owns the planner. Consumers can explicitly validate changes to the action they call.
        if (matchesGlob(file, 'packages/scripts/src/ci/**')) return false
        if (matchesGlob(file, plannerAction) && !target.watchPlannerAction) return false
        if (file === 'bun.lock') return !equalDependencies(before, after, target.workspaces)
        if (file === 'package.json') return true
        if (file.endsWith('/package.json')) {
          return (
            owned.has(file.slice(0, -'/package.json'.length)) ||
            matchesPaths(
              file,
              target.paths.filter((pattern) => !pattern.endsWith('/package.json') || !pattern.includes('*')),
            )
          )
        }
        return matchesPaths(file, target.paths)
      })
      return [name, changed]
    }),
  )
}

export const parseTargets = (
  workspaceInput: string,
  filterInput: string,
  workflowInput: string,
  event: string,
): Record<string, InputTarget> => {
  const workspaces = record(Bun.YAML.parse(workspaceInput))
  if (Object.keys(workspaces).length === 0) throw new Error('CI input selection requires at least one target')
  const filters = record(Bun.YAML.parse(filterInput || '{}'))
  const workflow = workflowInput ? record(Bun.YAML.parse(readFileSync(workflowInput, 'utf8'))) : undefined
  return Object.fromEntries(
    Object.entries(workspaces).map(([name, paths]) => {
      const selected = strings(paths)
      if (selected.length === 0) throw new Error(`CI input target ${name} requires installed workspaces`)
      const explicitPaths = filters[name] == null ? undefined : strings(filters[name])
      return [
        name,
        {
          workspaces: selected,
          paths: explicitPaths ?? strings(workflow ? record(record(workflow.on)[event]).paths : undefined),
          watchPlannerAction: explicitPaths?.includes(plannerAction) ?? false,
        },
      ]
    }),
  )
}

const git = (...args: string[]): string => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })

export const changedRange = (event: string, base: string, head: string): { base: string; head: string } => {
  if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha) && !/^0+$/.test(sha))) {
    throw new Error('CI input comparison requires valid nonzero base and head SHAs')
  }
  return { base: event === 'pull_request' ? git('merge-base', base, head).trim() : base, head }
}

export const selectAffectedRange = (
  event: string,
  base: string,
  head: string,
  targets: Record<string, InputTarget>,
  dependencyAwarePush: boolean,
) => {
  const range = changedRange(event, base, head)
  const files = git('diff', '--no-renames', '--name-only', '-z', range.base, range.head).split('\0').filter(Boolean)
  // Publishers without Bun inputs can use path selection without reading the lockfile.
  if (event === 'push' && !dependencyAwarePush) {
    return {
      files,
      affected: Object.fromEntries(
        Object.entries(targets).map(([name, target]) => [name, files.some((file) => matchesPaths(file, target.paths))]),
      ),
    }
  }
  return {
    files,
    affected: selectAffectedInputs(
      files,
      targets,
      Bun.JSONC.parse(git('show', `${range.base}:bun.lock`)),
      Bun.JSONC.parse(git('show', `${range.head}:bun.lock`)),
    ),
  }
}

if (import.meta.main) {
  const env = process.env
  const dependencyAwarePush = env.INPUT_DEPENDENCY_AWARE_PUSH ?? 'false'
  if (!['true', 'false'].includes(dependencyAwarePush)) throw new Error('dependency-aware-push must be true or false')
  const event = env.GITHUB_EVENT_NAME ?? ''
  if (!['pull_request', 'push', 'workflow_dispatch'].includes(event)) throw new Error(`Unsupported CI event: ${event}`)
  const onlyPaths = strings(Bun.YAML.parse(env.INPUT_ONLY_PATHS ?? '[]'))
  const targets = parseTargets(
    env.INPUT_WORKSPACES ?? '',
    env.INPUT_FILTERS ?? '',
    env.INPUT_WORKFLOW ?? '',
    event === 'workflow_dispatch' ? 'push' : event,
  )
  const { affected, files } =
    event === 'workflow_dispatch'
      ? { affected: Object.fromEntries(Object.keys(targets).map((name) => [name, true])), files: [] }
      : selectAffectedRange(event, env.BASE_SHA ?? '', env.HEAD_SHA ?? '', targets, dependencyAwarePush === 'true')
  const onlyPathsMatch = event === 'pull_request' && matchesOnlyPaths(files, onlyPaths)
  console.log(JSON.stringify(affected, null, 2))
  if (env.GITHUB_OUTPUT)
    appendFileSync(env.GITHUB_OUTPUT, `affected=${JSON.stringify(affected)}\nonly_paths=${onlyPathsMatch}\n`)
}
