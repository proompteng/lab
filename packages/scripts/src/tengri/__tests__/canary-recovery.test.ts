import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BffClient, cleanupState, ensureCanaryLease, recoverInterruptedCanary } from '../acceptance'
import { ownerFingerprint, parseCreationLease, type CreationLeaseStore } from '../creation-lease'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture(
  options: {
    present?: boolean
    conclusion?: string
    savedUid?: string
    pendingPvcReads?: number
    uploadFails?: boolean
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'tengri-recovery-test-'))
  directories.push(directory)
  let present = options.present ?? true
  let pendingPvcReads = options.pendingPvcReads ?? 0
  let agent = {
    id: 'agent-' + 'a'.repeat(32),
    displayName: 'tengri-acceptance-run-1',
    createdAt: '2026-09-07T00:00:00.000Z',
    phase: 'ready',
    message: '',
  }
  const uid = '11111111-1111-4111-8111-111111111111'
  const identity = {
    agentId: agent.id,
    displayName: agent.displayName,
    agentCreatedAt: agent.createdAt,
    microvmUid: options.savedUid ?? uid,
  }
  const lease = parseCreationLease(
    {
      version: 1,
      tool: 'tengri-canary-creation',
      ownerFingerprint: ownerFingerprint('primary'),
      canary: identity,
      run: { id: 42, attempt: 1, sha: 'b'.repeat(40), branch: 'kargo/tengri', event: 'push' },
    },
    ownerFingerprint('primary'),
  )
  const actions: string[] = []
  const reads: string[] = []
  const config = {
    baseUrl: 'http://localhost:8080',
    origin: 'http://localhost:8080',
    stage: 'tengri' as const,
    expectedRevision: 'a'.repeat(40),
    runId: 'test-run',
    authCookie: 'session=rotated-primary',
    rejectionAuthCookie: 'session=rejection',
    leaseFile: join(directory, 'lease.json'),
    outputPath: join(directory, 'evidence.json'),
    timeoutMs: 100,
    pollIntervalMs: 1,
    diagnostic: true,
  }
  const snapshot = () => ({
    authConfigured: true,
    controlPlaneConfigured: true,
    authenticated: true,
    previewGatewayOrigin: 'https://tengri.proompteng.ai',
    userId: 'primary',
    agents: present ? [agent] : [],
  })
  const fetchImpl: typeof fetch = async (_input, init) => {
    if (init?.method === 'GET') return Response.json({ ...snapshot(), user: { id: 'primary' } })
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body')
    const body: { action: string; displayName?: string } = JSON.parse(init.body)
    actions.push(body.action)
    if (body.action === 'create-agent') {
      present = true
      agent = { ...agent, displayName: body.displayName ?? '' }
      return Response.json({ result: agent })
    }
    if (body.action === 'delete-agent') {
      present = false
      return Response.json({ result: null })
    }
    throw new Error('Unexpected guest mutation in recovery: ' + body.action)
  }
  const store: CreationLeaseStore = {
    latest: async () => ({ lease, conclusion: options.conclusion ?? 'timed_out' }),
    save: async () => {
      if (options.uploadFails) throw new Error('Artifact upload failed')
    },
  }
  const state: Parameters<typeof recoverInterruptedCanary>[0] = {
    options: config,
    fetchImpl,
    primary: new BffClient(config, fetchImpl),
    rejection: new BffClient(config, fetchImpl),
    runner: async (_command, args) => {
      const kind = args[args.indexOf('get') + 1]
      reads.push(kind ?? '')
      let value: unknown
      if (kind === 'microvms.runtime.proompteng.ai') {
        const other = {
          metadata: { name: 'user-workspace' },
          spec: { image: 'registry/example@sha256:' + 'c'.repeat(64) },
        }
        value = { items: present ? [other, { metadata: { name: agent.id }, spec: other.spec }] : [other] }
      } else if (kind === 'microvm.runtime.proompteng.ai')
        value = present ? { metadata: { name: agent.id, uid } } : undefined
      else if (kind === 'pod' || kind === 'pvc') {
        const pending = kind === 'pvc' && pendingPvcReads-- > 0
        value =
          present || pending
            ? {
                metadata: {
                  name: agent.id,
                  uid: 'child-uid',
                  ownerReferences: [{ kind: 'MicroVM', name: agent.id, uid, controller: true }],
                },
              }
            : undefined
      } else throw new Error('Unexpected Kubernetes query')
      return { stdout: value ? JSON.stringify(value) : '', stderr: '', exitCode: 0 }
    },
    evidence: {
      schemaVersion: 1,
      status: 'running',
      acceptance: 'incomplete',
      diagnostic: true,
      startedAt: '2026-09-07T00:00:00.000Z',
      stage: 'tengri',
      expectedEventRevision: config.expectedRevision,
      provenance: {},
      delivery: {},
      checks: {},
      codexAccount: { status: 'not_run' },
    },
    creationLeaseStore: store,
    leaseDurable: false,
    fileOwned: false,
    previewSessionIds: [],
    previewGatewayOrigin: '',
    activeCheck: 'recovery',
  }
  return { state, snapshot, actions, reads, store }
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

describe('interrupted canary recovery through the BFF', () => {
  it('disposes only the recorded timed-out canary and proves its resources absent before another create', async () => {
    const { state, snapshot, actions, reads } = fixture()
    expect((await recoverInterruptedCanary(state, snapshot())).agents).toEqual([])
    expect(actions).toEqual(['delete-agent'])
    expect(reads.filter((kind) => kind === 'pod').length).toBeGreaterThanOrEqual(2)
    expect(reads.filter((kind) => kind === 'pvc').length).toBeGreaterThanOrEqual(2)
    expect(state.evidence.checks.recovery?.status).toBe('passed')
    expect(state.agent).toBeUndefined()
  })

  it('cannot delete a changed MicroVM incarnation or a canary deliberately retained after failure', async () => {
    for (const options of [
      { savedUid: '22222222-2222-4222-8222-222222222222' },
      { conclusion: 'failure' },
      { conclusion: 'success' },
    ]) {
      const { state, snapshot, actions } = fixture(options)
      await expectFailure(recoverInterruptedCanary(state, snapshot()))
      expect(actions).toEqual([])
    }
  })

  it('rejects an owner with an existing agent when the durable lease is unavailable', async () => {
    const { state, snapshot, actions, store } = fixture()
    store.latest = async () => undefined
    await expectFailure(recoverInterruptedCanary(state, snapshot()), 'no durable creation lease')
    expect(actions).toEqual([])
  })

  it('waits for a previous delete to finish garbage collection without repeating the delete', async () => {
    const { state, snapshot, actions, reads } = fixture({ present: false, conclusion: 'failure', pendingPvcReads: 2 })
    expect((await recoverInterruptedCanary(state, snapshot())).agents).toEqual([])
    expect(actions).toEqual([])
    expect(reads.filter((kind) => kind === 'pvc').length).toBe(3)
  })

  it('cleans a newly created canary if artifact upload fails, before any guest checks or content writes', async () => {
    const { state, snapshot, actions, reads } = fixture({ present: false, uploadFails: true })
    await expectFailure(ensureCanaryLease(state, snapshot()), 'Artifact upload failed')
    expect(state.lease?.microvmUid).toBeDefined()
    expect(await cleanupState(state)).toBeUndefined()
    expect(actions).toEqual(['create-agent', 'delete-agent'])
    expect(reads).toContain('pvc')
    expect(reads).toContain('pod')
  })
})
