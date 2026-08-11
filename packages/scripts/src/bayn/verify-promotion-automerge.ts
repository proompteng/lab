#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import process from 'node:process'

export const baynPromotionAutomergeWorkflowName = 'bayn-promotion-automerge'
export const baynPromotionBranch = 'codex/bayn-release-current'
export const baynPromotionAutomergeManifestPaths = [
  'argocd/applications/bayn/deployment.yaml',
  'argocd/applications/bayn/kustomization.yaml',
  'argocd/applications/bayn/lifecycle-current.yaml',
] as const

const optionalPromotionManifestPaths = new Set([
  'argocd/applications/bayn/lifecycle-previous.yaml',
  'argocd/applicationsets/product.yaml',
])

export const baynPromotionAutomergeRequiredChecks = [
  { workflow: 'Semantic Commits', name: 'Lint commit messages' },
  { workflow: 'Semantic Pull Request', name: 'Validate PR title' },
  { workflow: 'CI', name: 'Plan changed-area validation' },
  { workflow: 'CI', name: 'PR validation (argo-lint)' },
  { workflow: 'CI', name: 'PR validation (kubeconform)' },
  { workflow: 'CI', name: 'ci-pr' },
  { workflow: 'bayn', name: 'changes' },
  { workflow: 'bayn', name: 'pr-checks / run' },
  { workflow: 'bayn', name: 'effect-runtime-compatibility' },
  { workflow: 'bayn', name: 'broker-sandbox-contract' },
  { workflow: 'bayn', name: 'postgres-integration' },
  { workflow: 'bayn', name: 'dependency-input-invariant' },
  { workflow: 'bayn', name: 'Bayn release gate' },
  { workflow: 'bayn-promotion-eligibility', name: 'Bayn promotion exact-head gate' },
] as const

const allowedSkippedChecks = new Set([
  'CI\u0000Agents CI',
  'bayn\u0000image',
  'bayn-promotion-eligibility\u0000Refresh eligible promotion gate',
])

export interface BaynPromotionAutomergeFile {
  readonly path: string
  readonly status: string
}

export interface BaynPromotionAutomergeCheck {
  readonly workflow: string
  readonly name: string
  readonly state: string
  readonly link: string
}

export interface BaynPromotionAutomergePullRequest {
  readonly number: number
  readonly state: string
  readonly isDraft: boolean
  readonly mergeable: string
  readonly mergeStateStatus: string
  readonly headRefName: string
  readonly headRefOid: string
  readonly headRepository: string
  readonly baseRefName: string
  readonly baseRefOid: string
  readonly autoMergeEnabled: boolean
  readonly labels: readonly string[]
  readonly files: readonly BaynPromotionAutomergeFile[]
}

export interface BaynPromotionAutomergeSnapshot {
  readonly repository: string
  readonly defaultBranchSha: string
  readonly pullRequest: BaynPromotionAutomergePullRequest
  readonly checks: readonly BaynPromotionAutomergeCheck[]
}

export type BaynPromotionAutomergeDecision =
  | {
      readonly status: 'eligible'
      readonly prNumber: number
      readonly headSha: string
      readonly baseSha: string
    }
  | {
      readonly status: 'hold'
      readonly code:
        | 'repository-mismatch'
        | 'pull-request-mismatch'
        | 'pull-request-not-open'
        | 'pull-request-draft'
        | 'pull-request-shape-mismatch'
        | 'pull-request-head-mismatch'
        | 'pull-request-base-mismatch'
        | 'pull-request-not-mergeable'
        | 'automerge-already-enabled'
        | 'automerge-opted-out'
        | 'promotion-paths-mismatch'
        | 'check-evidence-ambiguous'
        | 'check-evidence-untrusted'
        | 'required-check-missing'
        | 'required-check-not-successful'
        | 'unexpected-check-not-successful'
      readonly message: string
    }

interface ExpectedBaynPromotionAutomerge {
  readonly repository: string
  readonly pullNumber: number
  readonly headSha: string
  readonly defaultBranchSha: string
}

const shaPattern = /^[0-9a-f]{40}$/

const hold = (
  code: Extract<BaynPromotionAutomergeDecision, { readonly status: 'hold' }>['code'],
  message: string,
): BaynPromotionAutomergeDecision => ({ status: 'hold', code, message })

const checkKey = (check: Pick<BaynPromotionAutomergeCheck, 'workflow' | 'name'>): string =>
  `${check.workflow}\u0000${check.name}`

const isTrustedActionsCheckLink = (repository: string, link: string): boolean => {
  try {
    const url = new URL(link)
    const segments = url.pathname.split('/').filter((segment) => segment.length > 0)
    const repositorySegments = repository.split('/')
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      segments.length === 7 &&
      segments[0] === repositorySegments[0] &&
      segments[1] === repositorySegments[1] &&
      segments[2] === 'actions' &&
      segments[3] === 'runs' &&
      /^[0-9]+$/.test(segments[4] ?? '') &&
      segments[5] === 'job' &&
      /^[0-9]+$/.test(segments[6] ?? '')
    )
  } catch {
    return false
  }
}

export const decideBaynPromotionAutomerge = (
  expected: ExpectedBaynPromotionAutomerge,
  snapshot: BaynPromotionAutomergeSnapshot,
): BaynPromotionAutomergeDecision => {
  if (snapshot.repository !== expected.repository) {
    return hold(
      'repository-mismatch',
      `snapshot repository ${snapshot.repository} does not match ${expected.repository}`,
    )
  }
  const pullRequest = snapshot.pullRequest
  if (pullRequest.number !== expected.pullNumber) {
    return hold('pull-request-mismatch', `snapshot PR #${pullRequest.number} does not match #${expected.pullNumber}`)
  }
  if (pullRequest.state !== 'OPEN') {
    return hold('pull-request-not-open', `PR #${pullRequest.number} is ${pullRequest.state}`)
  }
  if (pullRequest.isDraft) {
    return hold('pull-request-draft', `PR #${pullRequest.number} is a draft`)
  }
  if (
    pullRequest.headRefName !== baynPromotionBranch ||
    pullRequest.headRepository !== expected.repository ||
    pullRequest.baseRefName !== 'main'
  ) {
    return hold('pull-request-shape-mismatch', `PR #${pullRequest.number} is not the preserved Bayn promotion PR`)
  }
  if (pullRequest.headRefOid !== expected.headSha) {
    return hold(
      'pull-request-head-mismatch',
      `PR #${pullRequest.number} head changed from ${expected.headSha} to ${pullRequest.headRefOid}`,
    )
  }
  if (snapshot.defaultBranchSha !== expected.defaultBranchSha || pullRequest.baseRefOid !== expected.defaultBranchSha) {
    return hold(
      'pull-request-base-mismatch',
      `PR #${pullRequest.number} is not based on current main ${expected.defaultBranchSha}`,
    )
  }
  if (pullRequest.mergeable !== 'MERGEABLE' || pullRequest.mergeStateStatus !== 'CLEAN') {
    return hold(
      'pull-request-not-mergeable',
      `PR #${pullRequest.number} is ${pullRequest.mergeable}/${pullRequest.mergeStateStatus}`,
    )
  }
  if (pullRequest.autoMergeEnabled) {
    return hold('automerge-already-enabled', `PR #${pullRequest.number} already has a separate auto-merge request`)
  }
  if (pullRequest.labels.includes('do-not-automerge')) {
    return hold('automerge-opted-out', `PR #${pullRequest.number} has the do-not-automerge label`)
  }

  const expectedPaths = new Set<string>(baynPromotionAutomergeManifestPaths)
  const actualPaths = new Set(pullRequest.files.map(({ path }) => path))
  if (
    [...expectedPaths].some((path) => !actualPaths.has(path)) ||
    [...actualPaths].some((path) => !expectedPaths.has(path) && !optionalPromotionManifestPaths.has(path)) ||
    pullRequest.files.some(({ status }) => status !== 'MODIFIED')
  ) {
    return hold(
      'promotion-paths-mismatch',
      `PR #${pullRequest.number} must modify the exact Bayn release manifests and no unrelated path`,
    )
  }

  const checksByKey = new Map<string, BaynPromotionAutomergeCheck>()
  for (const check of snapshot.checks) {
    if (check.workflow === baynPromotionAutomergeWorkflowName) continue
    const key = checkKey(check)
    if (checksByKey.has(key)) {
      return hold('check-evidence-ambiguous', `multiple current checks reported for ${check.workflow} / ${check.name}`)
    }
    if (!isTrustedActionsCheckLink(expected.repository, check.link)) {
      return hold(
        'check-evidence-untrusted',
        `check ${check.workflow} / ${check.name} is not bound to this repository's GitHub Actions`,
      )
    }
    checksByKey.set(key, check)
  }

  for (const required of baynPromotionAutomergeRequiredChecks) {
    const key = checkKey(required)
    const check = checksByKey.get(key)
    if (check === undefined) {
      return hold('required-check-missing', `required check ${required.workflow} / ${required.name} is missing`)
    }
    if (check.state !== 'SUCCESS') {
      return hold(
        'required-check-not-successful',
        `required check ${required.workflow} / ${required.name} is ${check.state}`,
      )
    }
  }

  for (const [key, check] of checksByKey) {
    if (check.state === 'SUCCESS') continue
    if (check.state === 'SKIPPED' && allowedSkippedChecks.has(key)) continue
    return hold('unexpected-check-not-successful', `check ${check.workflow} / ${check.name} is ${check.state}`)
  }

  return {
    status: 'eligible',
    prNumber: pullRequest.number,
    headSha: pullRequest.headRefOid,
    baseSha: pullRequest.baseRefOid,
  }
}

const record = (value: unknown, path: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

const string = (value: unknown, path: string): string => {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`)
  return value
}

const boolean = (value: unknown, path: string): boolean => {
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`)
  return value
}

const number = (value: unknown, path: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${path} must be a positive integer`)
  return value as number
}

const array = (value: unknown, path: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`)
  return value
}

export const parseBaynPromotionAutomergeSnapshot = (value: unknown): BaynPromotionAutomergeSnapshot => {
  const root = record(value, 'snapshot')
  const pullRequest = record(root.pullRequest, 'snapshot.pullRequest')
  return {
    repository: string(root.repository, 'snapshot.repository'),
    defaultBranchSha: string(root.defaultBranchSha, 'snapshot.defaultBranchSha'),
    pullRequest: {
      number: number(pullRequest.number, 'snapshot.pullRequest.number'),
      state: string(pullRequest.state, 'snapshot.pullRequest.state'),
      isDraft: boolean(pullRequest.isDraft, 'snapshot.pullRequest.isDraft'),
      mergeable: string(pullRequest.mergeable, 'snapshot.pullRequest.mergeable'),
      mergeStateStatus: string(pullRequest.mergeStateStatus, 'snapshot.pullRequest.mergeStateStatus'),
      headRefName: string(pullRequest.headRefName, 'snapshot.pullRequest.headRefName'),
      headRefOid: string(pullRequest.headRefOid, 'snapshot.pullRequest.headRefOid'),
      headRepository: string(pullRequest.headRepository, 'snapshot.pullRequest.headRepository'),
      baseRefName: string(pullRequest.baseRefName, 'snapshot.pullRequest.baseRefName'),
      baseRefOid: string(pullRequest.baseRefOid, 'snapshot.pullRequest.baseRefOid'),
      autoMergeEnabled: boolean(pullRequest.autoMergeEnabled, 'snapshot.pullRequest.autoMergeEnabled'),
      labels: array(pullRequest.labels, 'snapshot.pullRequest.labels').map((label, index) =>
        string(label, `snapshot.pullRequest.labels[${index}]`),
      ),
      files: array(pullRequest.files, 'snapshot.pullRequest.files').map((file, index) => {
        const parsed = record(file, `snapshot.pullRequest.files[${index}]`)
        return {
          path: string(parsed.path, `snapshot.pullRequest.files[${index}].path`),
          status: string(parsed.status, `snapshot.pullRequest.files[${index}].status`),
        }
      }),
    },
    checks: array(root.checks, 'snapshot.checks').map((check, index) => {
      const parsed = record(check, `snapshot.checks[${index}]`)
      return {
        workflow: string(parsed.workflow, `snapshot.checks[${index}].workflow`),
        name: string(parsed.name, `snapshot.checks[${index}].name`),
        state: string(parsed.state, `snapshot.checks[${index}].state`),
        link: string(parsed.link, `snapshot.checks[${index}].link`),
      }
    }),
  }
}

interface CliOptions extends ExpectedBaynPromotionAutomerge {
  readonly snapshotPath: string
}

const parsePositiveInteger = (value: string, name: string): number => {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}

export const parseBaynPromotionAutomergeArguments = (arguments_: readonly string[]): CliOptions => {
  const values = new Map<string, string>()
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index]
    const value = arguments_[index + 1]
    if (name === undefined || !name.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error('arguments must be provided as --name value pairs')
    }
    if (values.has(name)) throw new Error(`duplicate argument ${name}`)
    values.set(name, value)
  }
  const allowed = new Set(['--repository', '--pull-number', '--head-sha', '--default-branch-sha', '--snapshot-path'])
  for (const name of values.keys()) {
    if (!allowed.has(name)) throw new Error(`unknown argument ${name}`)
  }
  const repository = values.get('--repository') ?? ''
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new Error('--repository must be owner/name')
  const headSha = values.get('--head-sha') ?? ''
  if (!shaPattern.test(headSha)) throw new Error('--head-sha must be a lowercase 40-character commit SHA')
  const defaultBranchSha = values.get('--default-branch-sha') ?? ''
  if (!shaPattern.test(defaultBranchSha)) {
    throw new Error('--default-branch-sha must be a lowercase 40-character commit SHA')
  }
  const snapshotPath = values.get('--snapshot-path') ?? ''
  if (snapshotPath.length === 0) throw new Error('--snapshot-path is required')
  return {
    repository,
    pullNumber: parsePositiveInteger(values.get('--pull-number') ?? '', '--pull-number'),
    headSha,
    defaultBranchSha,
    snapshotPath,
  }
}

const run = (): void => {
  const options = parseBaynPromotionAutomergeArguments(process.argv.slice(2))
  const snapshot = parseBaynPromotionAutomergeSnapshot(JSON.parse(readFileSync(options.snapshotPath, 'utf8')))
  const decision = decideBaynPromotionAutomerge(options, snapshot)
  if (decision.status === 'hold') {
    console.error(`BAYN_PROMOTION_AUTOMERGE_HOLD ${decision.code}: ${decision.message}`)
    process.exitCode = 1
    return
  }
  console.log(
    `BAYN_PROMOTION_AUTOMERGE_ELIGIBLE pr=#${decision.prNumber} head=${decision.headSha} base=${decision.baseSha}`,
  )
}

if (import.meta.main) {
  try {
    run()
  } catch (error: unknown) {
    const name = error instanceof Error ? error.message : typeof error
    console.error(`BAYN_PROMOTION_AUTOMERGE_HOLD invalid-input: ${name}`)
    process.exitCode = 1
  }
}
