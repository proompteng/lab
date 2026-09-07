import { describe, expect, it } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { githubCreationLeaseStore, ownerFingerprint, parseCreationLease, verifyCreationRun } from '../creation-lease'

const owner = ownerFingerprint('dedicated-owner')
const canary = {
  agentId: 'agent-' + 'a'.repeat(32),
  displayName: 'tengri-acceptance-run-1',
  agentCreatedAt: '2026-09-07T00:00:00.000Z',
  microvmUid: '11111111-1111-4111-8111-111111111111',
}
const run = { id: 42, attempt: 1, sha: 'b'.repeat(40), branch: 'kargo/tengri', event: 'push' }
const lease = { version: 1, tool: 'tengri-canary-creation', ownerFingerprint: owner, canary, run }
const workflowRun = {
  id: 42,
  run_attempt: 1,
  head_sha: run.sha,
  head_branch: run.branch,
  event: run.event,
  path: '.github/workflows/tengri-post-deploy.yml',
  head_repository: { full_name: 'proompteng/lab' },
  status: 'completed',
  conclusion: 'timed_out',
}
const environment = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'proompteng/lab',
  GITHUB_API_URL: 'https://api.github.com',
  GITHUB_TOKEN: 'test-token',
  ACTIONS_RUNTIME_TOKEN: 'test-runtime-token',
  ACTIONS_RESULTS_URL: 'https://results.example',
  GITHUB_RUN_ID: '99',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_SHA: 'c'.repeat(40),
  GITHUB_REF_NAME: 'kargo/proompteng',
  GITHUB_EVENT_NAME: 'push',
}
const name = 'tengri-canary-creation-' + owner
const digest = 'sha256:' + 'd'.repeat(64)
const artifact = { id: 10, name, workflow_run: { id: 42 }, expired: false, digest }
type StoreDependencies = NonNullable<Parameters<typeof githubCreationLeaseStore>[1]>

function fixture(
  options: { artifacts?: (typeof artifact)[]; runOverride?: object; digestMismatch?: boolean; expired?: boolean } = {},
) {
  const calls: string[] = []
  const downloads: number[] = []
  const all = options.artifacts ?? [{ ...artifact, expired: options.expired ?? false }]
  const fetchImpl: typeof fetch = async (input) => {
    if (typeof input !== 'string') throw new Error('Expected an API URL string')
    const url = new URL(input)
    calls.push(url.pathname + url.search)
    if (url.pathname.endsWith('/artifacts')) {
      const page = Number(url.searchParams.get('page'))
      return Response.json({ total_count: all.length, artifacts: all.slice((page - 1) * 100, page * 100) })
    }
    // A rerun has advanced the parent run. The lease must use its original attempt.
    return Response.json(
      url.pathname.includes('/attempts/')
        ? { ...workflowRun, ...options.runOverride }
        : { ...workflowRun, run_attempt: 2 },
    )
  }
  const client: NonNullable<StoreDependencies['client']> = {
    uploadArtifact: async () => ({ id: 99, digest }),
    downloadArtifact: async (id, downloadOptions) => {
      downloads.push(id)
      expect(downloadOptions?.expectedHash).toBe(digest)
      expect(downloadOptions?.findBy?.workflowRunId).toBe(42)
      if (!downloadOptions?.path) throw new Error('Download path required')
      writeFileSync(join(downloadOptions.path, 'creation-lease.json'), JSON.stringify(lease))
      return { downloadPath: downloadOptions.path, digestMismatch: options.digestMismatch ?? false }
    },
  }
  return { store: githubCreationLeaseStore(environment, { client, fetchImpl }), calls, downloads }
}

async function expectFailure<T>(promise: Promise<T>, message?: string): Promise<void> {
  const failure: unknown = await promise.then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(Error)
  if (message) {
    if (!(failure instanceof Error)) throw new Error('Expected an error')
    expect(failure.message).toContain(message)
  }
}

describe('durable Tengri canary creation leases', () => {
  it('binds recovery to an authenticated owner across cookie rotation and validates exact incarnation fields', () => {
    expect(parseCreationLease(lease, owner).canary).toEqual(canary)
    expect(ownerFingerprint('dedicated-owner')).toBe(owner)
    expect(() => parseCreationLease(lease, ownerFingerprint('different-owner'))).toThrow('exact disposable canary')
    expect(() => parseCreationLease({ ...lease, canary: { ...canary, microvmUid: '' } }, owner)).toThrow(
      'exact disposable canary',
    )
    expect(() => parseCreationLease({ ...lease, canary: { ...canary, agentId: '../user-vm' } }, owner)).toThrow(
      'exact disposable canary',
    )
    expect(() => parseCreationLease({ ...lease, run: { ...run, branch: 'codex/untrusted' } }, owner)).toThrow(
      'authorized workflow event',
    )
  })

  it('requires artifact credentials before any create and accepts dispatch only from main', () => {
    expect(() => githubCreationLeaseStore({ ...environment, ACTIONS_RUNTIME_TOKEN: undefined })).toThrow(
      'required before creating',
    )
    expect(() => githubCreationLeaseStore({ ...environment, GITHUB_API_URL: 'https://elsewhere.example' })).toThrow(
      'required before creating',
    )
    expect(() => githubCreationLeaseStore({ ...environment, GITHUB_EVENT_NAME: 'pull_request' })).toThrow(
      'authorized workflow event',
    )
    expect(() =>
      githubCreationLeaseStore({
        ...environment,
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REF_NAME: 'codex/branch',
      }),
    ).toThrow('authorized workflow event')
    expect(() =>
      githubCreationLeaseStore({ ...environment, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_NAME: 'main' }),
    ).not.toThrow()
  })

  it('publishes one finalized lease per job containing no session credentials', async () => {
    let uploads = 0
    const client: NonNullable<StoreDependencies['client']> = {
      uploadArtifact: async (artifactName, files, _root, options) => {
        uploads += 1
        expect(artifactName).toBe(name)
        expect(options?.retentionDays).toBe(90)
        if (!files[0]) throw new Error('Missing lease file')
        const text = readFileSync(files[0], 'utf8')
        expect(text).not.toContain('test-token')
        expect(text).not.toContain('test-runtime-token')
        expect(text).not.toContain('dedicated-owner')
        expect(parseCreationLease(JSON.parse(text), owner).canary).toEqual(canary)
        return { id: 99, digest }
      },
      downloadArtifact: async () => {
        throw new Error('Unexpected download')
      },
    }
    const store = githubCreationLeaseStore(environment, { client })
    await store.save(owner, canary)
    await expectFailure(store.save(owner, canary), 'only one canary')
    expect(uploads).toBe(1)
  })

  it('rejects an upload without a finalized integrity receipt', async () => {
    const client: NonNullable<StoreDependencies['client']> = {
      uploadArtifact: async () => ({ id: 1 }),
      downloadArtifact: async () => ({}),
    }
    await expectFailure(
      githubCreationLeaseStore(environment, { client }).save(owner, canary),
      'guest checks were not started',
    )
  })

  it('finds the newest creation across stages and all pages, using the original attempt', async () => {
    const artifacts = Array.from({ length: 101 }, (_, index) => ({ ...artifact, id: index + 1 }))
    const { store, calls, downloads } = fixture({ artifacts })
    expect(await store.latest(owner)).toMatchObject({ lease: { canary, run }, conclusion: 'timed_out' })
    expect(downloads).toEqual([101])
    expect(calls.some((url) => url.endsWith('page=2'))).toBe(true)
    expect(calls).toContain('/repos/proompteng/lab/actions/runs/42/attempts/1')
  })

  it('does not fall back to an older lease when the latest is expired or corrupt', async () => {
    await expectFailure(fixture({ expired: true }).store.latest(owner), 'expired')
    await expectFailure(fixture({ digestMismatch: true }).store.latest(owner), 'integrity check failed')
  })

  it('rejects wrong workflow, repository, source, event, attempt, and unfinished run attestations', () => {
    const parsed = parseCreationLease(lease, owner)
    for (const override of [
      { path: '.github/workflows/untrusted.yml' },
      { head_repository: { full_name: 'elsewhere/lab' } },
      { head_sha: 'c'.repeat(40) },
      { event: 'pull_request' },
      { run_attempt: 2 },
      { status: 'in_progress' },
    ])
      expect(() => verifyCreationRun(parsed, { ...workflowRun, ...override })).toThrow('completed trusted workflow')
    expect(verifyCreationRun(parsed, workflowRun)).toBe('timed_out')
  })
})
