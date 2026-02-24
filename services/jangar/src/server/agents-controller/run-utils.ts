import { asRecord, asString, readNested } from '~/server/primitives-http'

const QUEUED_PHASES = new Set(['pending', 'queued', 'progressing', 'inprogress'])

export const resolveImplementation = (agentRun: Record<string, unknown>) => {
  return asRecord(readNested(agentRun, ['spec', 'implementation', 'inline'])) ?? null
}

export const resolveParameters = (agentRun: Record<string, unknown>) => {
  const raw = asRecord(readNested(agentRun, ['spec', 'parameters'])) ?? {}
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') continue
    params[key] = value
  }
  return params
}

export const resolveParam = (params: Record<string, string>, keys: string[]) => {
  for (const key of keys) {
    const value = params[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return ''
}

export const resolveRunParam = (run: Record<string, unknown>, keys: string[]) => {
  const raw = asRecord(readNested(run, ['spec', 'parameters'])) ?? {}
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') continue
    params[key] = value
  }
  return resolveParam(params, keys)
}

export const resolveRepositoryFromParameters = (parameters: Record<string, string>) => {
  const candidates = ['repository', 'repo', 'issueRepository']
  for (const key of candidates) {
    const value = parameters[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

export const resolveRunRepository = (agentRun: Record<string, unknown>) => {
  const statusRepo = asString(readNested(agentRun, ['status', 'vcs', 'repository'])) ?? ''
  if (statusRepo.trim()) return statusRepo.trim()
  const parameters = resolveParameters(agentRun)
  return resolveRepositoryFromParameters(parameters)
}

export const normalizeRepository = (value: string) => value.trim().toLowerCase()

export const normalizeBranchName = (value: string) => value.trim()

export const isActiveRun = (run: Record<string, unknown>) => {
  const phase = asString(readNested(run, ['status', 'phase'])) ?? 'Pending'
  return phase !== 'Succeeded' && phase !== 'Failed' && phase !== 'Cancelled'
}

export const isQueuedRun = (run: Record<string, unknown>) => {
  const phase = asString(readNested(run, ['status', 'phase'])) ?? 'Pending'
  return QUEUED_PHASES.has(phase.trim().toLowerCase())
}

export const resolveRunHeadBranch = (run: Record<string, unknown>) =>
  asString(readNested(run, ['status', 'vcs', 'headBranch'])) ??
  asString(readNested(run, ['status', 'vcs', 'branch'])) ??
  resolveRunParam(run, ['head', 'headBranch', 'head_ref', 'headRef', 'branch'])

export const hasBranchConflict = (
  runs: Record<string, unknown>[],
  currentRunName: string,
  repository: string,
  headBranch: string,
) => {
  if (!repository || !headBranch) return false
  const normalizedRepo = normalizeRepository(repository)
  const normalizedBranch = normalizeBranchName(headBranch)
  return runs.some((run) => {
    const runName = asString(readNested(run, ['metadata', 'name'])) ?? ''
    if (!runName || runName === currentRunName) return false
    if (!isActiveRun(run)) return false
    const runRepo = resolveRunRepository(run)
    if (!runRepo || normalizeRepository(runRepo) !== normalizedRepo) return false
    const runBranch = resolveRunHeadBranch(run)
    if (!runBranch) return false
    return normalizeBranchName(runBranch) === normalizedBranch
  })
}

export const appendBranchSuffix = (branch: string, suffix: string) => {
  const trimmed = suffix.trim()
  if (!trimmed) return branch
  const cleaned = trimmed.replace(/^[-/]+/, '')
  if (!cleaned) return branch
  const separator = branch.endsWith('/') || branch.endsWith('-') ? '' : '-'
  return `${branch}${separator}${cleaned}`
}

export const hasParameterValue = (parameters: Record<string, string>, keys: string[]) =>
  resolveParam(parameters, keys) !== ''

export const applyVcsMetadataToParameters = (
  parameters: Record<string, string>,
  vcsContext: Record<string, unknown> | null,
) => {
  if (!vcsContext) return parameters
  const baseBranch = asString(readNested(vcsContext, ['baseBranch'])) ?? ''
  const headBranch = asString(readNested(vcsContext, ['headBranch'])) ?? ''
  let updated = false
  const next = { ...parameters }
  if (baseBranch && !hasParameterValue(parameters, ['base', 'baseBranch', 'base_ref', 'baseRef'])) {
    next.base = baseBranch
    updated = true
  }
  if (headBranch && !hasParameterValue(parameters, ['head', 'headBranch', 'head_ref', 'headRef', 'branch'])) {
    next.head = headBranch
    updated = true
  }
  return updated ? next : parameters
}

export const setMetadataIfMissing = (metadata: Record<string, string>, key: string, value: string) => {
  if (!value || metadata[key]) return
  metadata[key] = value
}
