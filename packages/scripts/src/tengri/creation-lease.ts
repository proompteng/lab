import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DefaultArtifactClient, type ArtifactClient } from '@actions/artifact'

const REPOSITORY = 'proompteng/lab'
const WORKFLOW = '.github/workflows/tengri-post-deploy.yml'
const FILE_NAME = 'creation-lease.json'
const MAX_BYTES = 16 * 1024
const API_TIMEOUT_MS = 30_000

export type CanaryIdentity = {
  agentId: string
  displayName: string
  agentCreatedAt: string
  microvmUid: string
}

type RunIdentity = {
  id: number
  attempt: number
  sha: string
  branch: string
  event: string
}

export type CreationLease = {
  version: 1
  tool: 'tengri-canary-creation'
  ownerFingerprint: string
  canary: CanaryIdentity
  run: RunIdentity
}

export type RecoveredCreation = {
  lease: CreationLease
  conclusion: string | null
}

export interface CreationLeaseStore {
  latest(ownerFingerprint: string): Promise<RecoveredCreation | undefined>
  save(ownerFingerprint: string, canary: CanaryIdentity): Promise<void>
}

export function ownerFingerprint(userId: string): string {
  if (!userId) throw new Error('Authenticated owner is required for the canary lease')
  return createHash('sha256')
    .update('tengri-real-guest-owner-v1:' + userId)
    .digest('hex')
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid creation lease metadata')
  return value as Record<string, unknown>
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function trustedEvent(branch: unknown, event: unknown): boolean {
  return (
    (event === 'push' && (branch === 'kargo/tengri' || branch === 'kargo/proompteng')) ||
    (event === 'workflow_dispatch' && branch === 'main')
  )
}

function parseRun(value: unknown): RunIdentity {
  const run = record(value)
  if (
    !positiveInteger(run.id) ||
    !positiveInteger(run.attempt) ||
    typeof run.sha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(run.sha) ||
    typeof run.branch !== 'string' ||
    typeof run.event !== 'string' ||
    !trustedEvent(run.branch, run.event)
  )
    throw new Error('Creation lease is not from an authorized workflow event')
  return { id: run.id, attempt: run.attempt, sha: run.sha, branch: run.branch, event: run.event }
}

export function parseCreationLease(value: unknown, fingerprint: string): CreationLease {
  const lease = record(value)
  const canary = record(lease.canary)
  if (
    lease.version !== 1 ||
    lease.tool !== 'tengri-canary-creation' ||
    !/^[a-f0-9]{64}$/.test(fingerprint) ||
    lease.ownerFingerprint !== fingerprint ||
    typeof canary.agentId !== 'string' ||
    !/^agent-[a-f0-9]{32}$/.test(canary.agentId) ||
    typeof canary.displayName !== 'string' ||
    !/^tengri-acceptance-[A-Za-z0-9_-]{1,46}$/.test(canary.displayName) ||
    typeof canary.agentCreatedAt !== 'string' ||
    !Number.isFinite(Date.parse(canary.agentCreatedAt)) ||
    typeof canary.microvmUid !== 'string' ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(canary.microvmUid)
  )
    throw new Error('Creation lease does not identify this owner and an exact disposable canary')
  return {
    version: 1,
    tool: 'tengri-canary-creation',
    ownerFingerprint: fingerprint,
    canary: {
      agentId: canary.agentId,
      displayName: canary.displayName,
      agentCreatedAt: canary.agentCreatedAt,
      microvmUid: canary.microvmUid,
    },
    run: parseRun(lease.run),
  }
}

export function verifyCreationRun(lease: CreationLease, value: unknown): string | null {
  const run = record(value)
  if (
    run.id !== lease.run.id ||
    run.run_attempt !== lease.run.attempt ||
    run.head_sha !== lease.run.sha ||
    run.head_branch !== lease.run.branch ||
    run.event !== lease.run.event ||
    run.path !== WORKFLOW ||
    record(run.head_repository).full_name !== REPOSITORY ||
    run.status !== 'completed' ||
    (run.conclusion !== null && typeof run.conclusion !== 'string')
  )
    throw new Error('Creation lease does not match its completed trusted workflow run')
  return run.conclusion
}

type StoreDependencies = {
  client?: Pick<ArtifactClient, 'uploadArtifact' | 'downloadArtifact'>
  fetchImpl?: typeof fetch
}

export function githubCreationLeaseStore(
  environment: Record<string, string | undefined>,
  dependencies: StoreDependencies = {},
): CreationLeaseStore {
  if (
    environment.GITHUB_ACTIONS !== 'true' ||
    environment.GITHUB_REPOSITORY !== REPOSITORY ||
    environment.GITHUB_API_URL !== 'https://api.github.com' ||
    !environment.GITHUB_TOKEN ||
    !environment.ACTIONS_RUNTIME_TOKEN ||
    !environment.ACTIONS_RESULTS_URL
  )
    throw new Error('GitHub artifact read access and runner artifact credentials are required before creating a canary')
  const currentRun = parseRun({
    id: Number(environment.GITHUB_RUN_ID),
    attempt: Number(environment.GITHUB_RUN_ATTEMPT),
    sha: environment.GITHUB_SHA,
    branch: environment.GITHUB_REF_NAME,
    event: environment.GITHUB_EVENT_NAME,
  })
  const client = dependencies.client ?? new DefaultArtifactClient()
  const fetchImpl = dependencies.fetchImpl ?? fetch
  const token = environment.GITHUB_TOKEN
  let saved = false

  async function api(path: string): Promise<Record<string, unknown>> {
    const signal = AbortSignal.timeout(API_TIMEOUT_MS)
    try {
      const response = await fetchImpl('https://api.github.com/repos/' + REPOSITORY + path, {
        headers: {
          authorization: 'Bearer ' + token,
          accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        redirect: 'error',
        signal,
      })
      if (!response.ok) throw new Error('Artifact API failed')
      const body: unknown = await response.json()
      return record(body)
    } catch {
      throw new Error('Could not read trusted canary artifacts from GitHub')
    }
  }

  function artifactName(fingerprint: string): string {
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Invalid canary owner fingerprint')
    return 'tengri-canary-creation-' + fingerprint
  }

  return {
    async save(fingerprint, canary) {
      if (saved) throw new Error('A workflow job may create only one canary')
      const lease = parseCreationLease(
        {
          version: 1,
          tool: 'tengri-canary-creation',
          ownerFingerprint: fingerprint,
          canary,
          run: currentRun,
        },
        fingerprint,
      )
      const directory = mkdtempSync(join(tmpdir(), 'tengri-creation-'))
      try {
        const path = join(directory, FILE_NAME)
        writeFileSync(path, JSON.stringify(lease) + '\n', { mode: 0o600 })
        const uploaded = await client.uploadArtifact(artifactName(fingerprint), [path], directory, {
          retentionDays: 90,
        })
        if (!uploaded.id || !uploaded.digest) throw new Error('Canary creation artifact was not finalized')
        saved = true
      } catch {
        throw new Error('Could not persist the exact canary creation lease; guest checks were not started')
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
    async latest(fingerprint) {
      const name = artifactName(fingerprint)
      const artifacts: Record<string, unknown>[] = []
      // Read every page rather than assuming GitHub's list order or an upload limit per job.
      for (let page = 1; ; page += 1) {
        const result = await api('/actions/artifacts?name=' + name + '&per_page=100&page=' + String(page))
        if (!Array.isArray(result.artifacts) || typeof result.total_count !== 'number') {
          throw new Error('Invalid canary artifact inventory')
        }
        for (const value of result.artifacts) {
          const artifact = record(value)
          if (artifact.name !== name) throw new Error('Unexpected canary artifact name')
          artifacts.push(artifact)
        }
        if (page * 100 >= result.total_count) break
        if (result.artifacts.length === 0 || page >= 100)
          throw new Error('Canary artifact inventory could not be completed')
      }
      artifacts.sort((left, right) => Number(right.id) - Number(left.id))
      for (const artifact of artifacts) {
        const runId = record(artifact.workflow_run).id
        if (!positiveInteger(runId) || !positiveInteger(artifact.id))
          throw new Error('Invalid canary artifact identity')
        const run = await api('/actions/runs/' + String(runId))
        if (
          run.path !== WORKFLOW ||
          record(run.head_repository).full_name !== REPOSITORY ||
          !trustedEvent(run.head_branch, run.event)
        )
          continue
        // Never fall back to an older lease when the newest trusted one cannot be verified.
        if (
          artifact.expired !== false ||
          typeof artifact.digest !== 'string' ||
          !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)
        ) {
          throw new Error('The latest canary creation lease has expired or lacks an integrity receipt')
        }
        const directory = mkdtempSync(join(tmpdir(), 'tengri-recovery-'))
        try {
          const downloaded = await client.downloadArtifact(artifact.id, {
            path: directory,
            expectedHash: artifact.digest,
            findBy: { token, workflowRunId: runId, repositoryOwner: 'proompteng', repositoryName: 'lab' },
          })
          if (downloaded.digestMismatch !== false) throw new Error('Canary creation artifact integrity check failed')
          const path = join(directory, FILE_NAME)
          if (statSync(path).size > MAX_BYTES) throw new Error('Canary creation lease exceeds its size limit')
          const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
          const lease = parseCreationLease(value, fingerprint)
          const attempt = await api('/actions/runs/' + String(runId) + '/attempts/' + String(lease.run.attempt))
          return { lease, conclusion: verifyCreationRun(lease, attempt) }
        } finally {
          rmSync(directory, { recursive: true, force: true })
        }
      }
      return undefined
    },
  }
}
