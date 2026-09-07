import { ownerFingerprint as fingerprintOwner } from '../creation-lease'
import { describe, expect, it } from 'bun:test'

import {
  AcceptanceError,
  BffClient,
  type CommandRunner,
  CookieJar,
  HttpFailure,
  cleanupState,
  parseAcceptanceArgs,
  parseKustomizationDigests,
  parseStagePromotion,
  parseTerminalOutputFrame,
  readBodyText,
  markerCommand,
  sha256Hex,
  validateLeaseRecord,
} from '../acceptance'

const revision = 'a'.repeat(40)
const sourceRevision = 'b'.repeat(40)
const tengriDigest = 'sha256:' + '1'.repeat(64)
const nanoagentDigest = 'sha256:' + '2'.repeat(64)

describe('Tengri real guest acceptance helpers', () => {
  it('requires two distinct cookie sessions and a full Kargo event revision', () => {
    const environment = {
      TENGRI_AUTH_COOKIE: 'tengri_session=primary',
      TENGRI_REJECTION_AUTH_COOKIE: 'tengri_session=rejection',
      GITHUB_SHA: revision,
    }
    expect(parseAcceptanceArgs(['--stage', 'tengri'], environment)).toMatchObject({
      stage: 'tengri',
      expectedRevision: revision,
    })
    expect(() =>
      parseAcceptanceArgs(['--stage', 'tengri'], {
        ...environment,
        TENGRI_AUTH_COOKIE: undefined,
      }),
    ).toThrow('TENGRI_AUTH_COOKIE')
    expect(() =>
      parseAcceptanceArgs(['--stage', 'tengri'], {
        ...environment,
        TENGRI_REJECTION_AUTH_COOKIE: environment.TENGRI_AUTH_COOKIE,
      }),
    ).toThrow('different sessions')
    expect(() =>
      parseAcceptanceArgs(['--stage', 'tengri'], {
        ...environment,
        GITHUB_SHA: 'short',
      }),
    ).toThrow('full expected Kargo branch revision')
    expect(() =>
      parseAcceptanceArgs(['--stage', 'tengri'], {
        ...environment,
        TENGRI_ACCEPTANCE_LEASE_FILE: '/tmp/tengri-acceptance-same-path',
        TENGRI_ACCEPTANCE_OUTPUT: '/tmp/tengri-acceptance-same-path',
      }),
    ).toThrow('paths must be different')
  })

  it('keeps rotated cookies in memory and honors deletion Set-Cookie headers', () => {
    const jar = new CookieJar('tengri_session=primary; theme=dark')
    const headers = new Headers()
    headers.append('set-cookie', 'tengri_session=rotated; Path=/; HttpOnly')
    headers.append('set-cookie', 'theme=; Max-Age=0; Path=/')
    headers.append('set-cookie', 'fresh=value; Path=/')
    jar.apply(headers)
    expect(jar.has('tengri_session')).toBe(true)
    expect(jar.has('theme')).toBe(false)
    expect(jar.header()).toContain('tengri_session=rotated')
    expect(jar.header()).toContain('fresh=value')
  })

  it('bounds a response body that stalls after headers arrive and cancels it without waiting', async () => {
    let cancelled = false
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{'))
        },
        cancel() {
          cancelled = true
        },
      }),
      { status: 200 },
    )
    let failure: unknown
    const startedAt = Date.now()
    try {
      await readBodyText(response, 1024, 15, 'stalled response')
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AcceptanceError)
    expect((failure as AcceptanceError).message).toContain('response body timed out')
    expect(cancelled).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  it('parses the live Kargo promotion state shape and binds Freight to source', () => {
    const stage = {
      status: {
        lastPromotion: {
          freight: {
            name: 'tengri.freight.fixture',
            images: [
              {
                repoURL: 'registry.ide-newton.ts.net/lab/tengri',
                digest: tengriDigest,
                annotations: { 'org.opencontainers.image.revision': sourceRevision },
              },
              {
                repoURL: 'registry.ide-newton.ts.net/lab/nanoagent',
                digest: nanoagentDigest,
                annotations: { 'org.opencontainers.image.revision': sourceRevision },
              },
            ],
          },
          status: {
            phase: 'Succeeded',
            state: {
              commit: { commit: revision },
              push: { branch: 'kargo/tengri', commit: revision },
              'step-2': { commits: { './src': sourceRevision, './out': 'c'.repeat(40) } },
            },
          },
        },
      },
    }
    expect(parseStagePromotion('tengri', stage, revision)).toMatchObject({
      branch: 'kargo/tengri',
      branchRevision: revision,
      sourceRevision,
      freightName: 'tengri.freight.fixture',
      digests: { tengri: tengriDigest, nanoagent: nanoagentDigest },
    })
    expect(() =>
      parseStagePromotion(
        'tengri',
        {
          status: {
            lastPromotion: {
              state: stage.status.lastPromotion.status.state,
              status: stage.status.lastPromotion.status,
              freight: stage.status.lastPromotion.freight,
            },
          },
        },
        revision,
      ),
    ).not.toThrow()
    expect(() =>
      parseStagePromotion(
        'tengri',
        {
          status: {
            lastPromotion: {
              freight: stage.status.lastPromotion.freight,
              status: { phase: 'Succeeded', state: stage.status.lastPromotion.status.state },
              state: stage.status.lastPromotion.status.state,
            },
          },
        },
        revision,
      ),
    ).not.toThrow()
  })

  it('rejects a promotion whose source revision is absent or whose image metadata differs', () => {
    const base = {
      status: {
        lastPromotion: {
          freight: {
            name: 'tengri.freight.fixture',
            images: [
              {
                repoURL: 'registry.ide-newton.ts.net/lab/tengri',
                digest: tengriDigest,
                annotations: { 'org.opencontainers.image.revision': sourceRevision },
              },
              {
                repoURL: 'registry.ide-newton.ts.net/lab/nanoagent',
                digest: nanoagentDigest,
                annotations: { 'org.opencontainers.image.revision': sourceRevision },
              },
            ],
          },
          status: {
            phase: 'Succeeded',
            state: {
              commit: { commit: revision },
              push: { branch: 'kargo/tengri', commit: revision },
              'step-2': { commits: { './out': 'c'.repeat(40) } },
            },
          },
        },
      },
    }
    expect(() => parseStagePromotion('tengri', base, revision)).toThrow('source revision')
    expect(() =>
      parseStagePromotion(
        'tengri',
        {
          ...base,
          status: {
            lastPromotion: {
              ...base.status.lastPromotion,
              status: {
                ...base.status.lastPromotion.status,
                state: {
                  ...base.status.lastPromotion.status.state,
                  'step-2': { commits: { './src': sourceRevision } },
                },
              },
              freight: {
                ...base.status.lastPromotion.freight,
                images: base.status.lastPromotion.freight.images.map((image, index) =>
                  index === 0
                    ? { ...image, annotations: { 'org.opencontainers.image.revision': 'c'.repeat(40) } }
                    : image,
                ),
              },
            },
          },
        },
        revision,
      ),
    ).toThrow('Freight image metadata')
  })

  it('accepts only a lease bound to the authenticated owner fingerprint and safe owned paths', () => {
    const ownerFingerprint = fingerprintOwner('primary')
    const lease = {
      version: 3,
      tool: 'tengri-real-guest-acceptance',
      agentId: 'agent-acceptance',
      displayName: 'tengri-acceptance-run-123',
      agentCreatedAt: '2026-09-07T00:00:00.000Z',
      microvmUid: 'mvm-uid-acceptance',
      leaseId: '0123456789abcdef',
      ownerFingerprint,
      createdAt: '2026-09-07T00:00:00.000Z',
      firstRunId: 'run-123',
      terminalCreationId: 'tengri-acceptance-agent-acceptance-0123456789abcdef',
      filePath: '/workspace/.tengri-acceptance-0123456789abcdef.txt',
      filePrefix: 'tengri-acceptance:v1:agent-acceptance:0123456789abcdef:',
      fileContentSha256: 'd'.repeat(64),
      previewSessionIds: [],
    }
    expect(validateLeaseRecord(lease, ownerFingerprint)).toMatchObject({
      agentId: lease.agentId,
      leaseId: lease.leaseId,
      agentCreatedAt: lease.agentCreatedAt,
      microvmUid: lease.microvmUid,
    })
    expect(() => validateLeaseRecord({ ...lease, version: 1 }, ownerFingerprint)).toThrow('invalid')
    expect(() => validateLeaseRecord(lease, fingerprintOwner('other'))).toThrow('another identity')
    expect(() => validateLeaseRecord({ ...lease, filePath: '/workspace/../other.txt' }, ownerFingerprint)).toThrow(
      'unsafe owned resource',
    )
  })

  it('stops cleanup before agent deletion when the owned file or incarnation is uncertain', async () => {
    const originalContent = 'tengri acceptance content'
    const options = {
      baseUrl: 'http://localhost:8080',
      origin: 'http://localhost:8080',
      stage: 'tengri' as const,
      expectedRevision: 'a'.repeat(40),
      runId: 'run-123',
      authCookie: 'tengri_session=primary',
      rejectionAuthCookie: 'tengri_session=rejection',
      leaseFile: '/tmp/tengri-acceptance-test-lease.json',
      outputPath: '/tmp/tengri-acceptance-test-evidence.json',
      timeoutMs: 10,
      pollIntervalMs: 1,
      diagnostic: true,
    }
    const lease = validateLeaseRecord(
      {
        version: 3,
        tool: 'tengri-real-guest-acceptance',
        agentId: 'agent-acceptance',
        displayName: 'tengri-acceptance-run-123',
        agentCreatedAt: '2026-09-07T00:00:00.000Z',
        microvmUid: 'mvm-uid-acceptance',
        leaseId: '0123456789abcdef',
        ownerFingerprint: fingerprintOwner('primary'),
        createdAt: '2026-09-07T00:00:00.000Z',
        firstRunId: 'run-123',
        terminalCreationId: 'tengri-acceptance-agent-acceptance-0123456789abcdef',
        filePath: '/workspace/.tengri-acceptance-0123456789abcdef.txt',
        filePrefix: 'tengri-acceptance:v1:agent-acceptance:0123456789abcdef:',
        fileContentSha256: sha256Hex(originalContent),
        previewSessionIds: [],
      },
      fingerprintOwner('primary'),
    )
    if (!lease.microvmUid) throw new Error('test lease must include a MicroVM UID')
    const makeState = (
      fileRead: unknown,
      createdAt = lease.agentCreatedAt,
    ): Parameters<typeof cleanupState>[0] & {
      actions: string[]
    } => {
      const actions: string[] = []
      const fetchImpl: typeof fetch = async (_input, init) => {
        if (init?.method === 'GET') {
          return Response.json({
            authConfigured: true,
            controlPlaneConfigured: true,
            authenticated: true,
            previewGatewayOrigin: 'https://tengri.proompteng.ai',
            user: { id: 'primary' },
            agents: [{ id: lease.agentId, displayName: lease.displayName, createdAt, phase: 'ready', message: '' }],
          })
        }
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { action?: unknown }) : {}
        const action = typeof body.action === 'string' ? body.action : ''
        actions.push(action)
        if (action === 'read-file') {
          if (fileRead instanceof HttpFailure)
            return Response.json({ error: 'read failed' }, { status: fileRead.status })
          if (fileRead instanceof Error) throw fileRead
          return Response.json({ result: fileRead })
        }
        if (action === 'delete-file') return Response.json({ error: 'delete failed' }, { status: 500 })
        return Response.json({ result: null })
      }
      const runner: CommandRunner = async () => ({
        stdout: JSON.stringify({ metadata: { uid: lease.microvmUid } }),
        stderr: '',
        exitCode: 0,
      })
      const primary = new BffClient(options, fetchImpl)
      const state: Parameters<typeof cleanupState>[0] = {
        options,
        runner,
        fetchImpl,
        primary,
        rejection: new BffClient({ ...options, authCookie: options.rejectionAuthCookie }, fetchImpl),
        evidence: {
          schemaVersion: 1,
          status: 'running',
          acceptance: 'incomplete',
          diagnostic: true,
          startedAt: '2026-09-07T00:00:00.000Z',
          stage: 'tengri',
          expectedEventRevision: options.expectedRevision,
          provenance: {},
          delivery: {},
          checks: {},
          codexAccount: { status: 'not_run' },
        },
        lease,
        leaseDurable: true,
        agent: { id: lease.agentId, displayName: lease.displayName, createdAt, phase: 'ready', message: '' },
        runtime: {
          microvmUid: lease.microvmUid,
          podName: 'pod-acceptance',
          podUid: 'pod-uid-acceptance',
          pvcName: 'pvc-acceptance',
          pvcUid: 'pvc-uid-acceptance',
          bootstrapSecretName: 'secret-acceptance',
          image: 'registry.ide-newton.ts.net/lab/nanoagent@sha256:' + '2'.repeat(64),
        },
        fileOwned: true,
        filePath: lease.filePath,
        fileContentSha256: lease.fileContentSha256,
        terminalId: undefined,
        previewSessionIds: [],
        previewGatewayOrigin: '',
        activeCheck: 'fileCas',
      }
      return Object.assign(state, { actions })
    }

    const changed = makeState({ path: lease.filePath, content: 'changed', revision: 'c'.repeat(64) })
    expect(await cleanupState(changed)).toBeInstanceOf(AcceptanceError)
    expect(changed.actions).toEqual(['read-file'])

    const missing = makeState(new HttpFailure('read file', 404))
    expect(await cleanupState(missing)).toBeInstanceOf(AcceptanceError)
    expect(missing.actions).toEqual(['read-file'])

    const unreadable = makeState(new HttpFailure('read file', 500))
    expect(await cleanupState(unreadable)).toBeInstanceOf(AcceptanceError)
    expect(unreadable.actions).toEqual(['read-file'])

    const deleteFailure = makeState({
      path: lease.filePath,
      content: originalContent,
      revision: sha256Hex(originalContent),
    })
    expect(await cleanupState(deleteFailure)).toBeInstanceOf(AcceptanceError)
    expect(deleteFailure.actions).toEqual(['read-file', 'read-file', 'delete-file'])

    const changedIncarnation = makeState(
      { path: lease.filePath, content: originalContent, revision: sha256Hex(originalContent) },
      '2026-09-07T01:00:00.000Z',
    )
    expect(await cleanupState(changedIncarnation)).toBeInstanceOf(AcceptanceError)
    expect(changedIncarnation.actions).toEqual([])
    for (const sample of [changed, missing, unreadable, deleteFailure, changedIncarnation]) {
      expect(sample.actions).not.toContain('delete-agent')
    }
  })

  it('parses the binary PTY output frame and rejects malformed cursors', () => {
    const frame = new Uint8Array(8)
    frame[0] = 1
    new DataView(frame.buffer).setUint32(1, 42, false)
    frame.set(new TextEncoder().encode('ok\n'), 5)
    expect(parseTerminalOutputFrame(frame)).toMatchObject({ sequence: 42 })
    expect(new TextDecoder().decode(parseTerminalOutputFrame(frame)!.payload)).toBe('ok\n')
    expect(parseTerminalOutputFrame(new Uint8Array([1, 0, 0, 0, 0, 0]))).toBeNull()
    expect(parseTerminalOutputFrame(new Uint8Array([2, 0, 0, 0, 1, 0]))).toBeNull()
  })

  it('splits probe markers so a PTY echo cannot satisfy the output assertion', () => {
    const marker = 'TENGRI_PTY_ROUNDTRIP_0123456789abcdef'
    const command = markerCommand(marker)
    expect(command).not.toContain(marker)
    expect(command).toContain(marker.slice(0, Math.ceil(marker.length / 2)))
    expect(command).toContain(marker.slice(Math.ceil(marker.length / 2)))
  })

  it('requires digest-pinned Kargo branch manifests for both applications', () => {
    const tengriManifest = `
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
images:
  - name: registry.ide-newton.ts.net/lab/tengri
    digest: ${tengriDigest}
configMapGenerator:
  - name: tengri-release
    literals:
      - NANOAGENT_IMAGE=registry.ide-newton.ts.net/lab/nanoagent@${nanoagentDigest}
`
    expect(parseKustomizationDigests('tengri', tengriManifest)).toEqual({
      tengri: tengriDigest,
      nanoagent: nanoagentDigest,
    })
    expect(() => parseKustomizationDigests('tengri', tengriManifest.replace('digest:', 'newTag:'))).toThrow(
      'not digest pinned',
    )
    expect(
      parseKustomizationDigests(
        'proompteng',
        `images:\n  - name: registry.ide-newton.ts.net/lab/proompteng\n    digest: ${tengriDigest}\n`,
      ),
    ).toEqual({ proompteng: tengriDigest })
  })
})
