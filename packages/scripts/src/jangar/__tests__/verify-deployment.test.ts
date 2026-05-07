import { describe, expect, it } from 'bun:test'

import { parseArgoApplicationStatus } from '../../shared/argo'
import { __private } from '../verify-deployment'

describe('verify-deployment', () => {
  const expectedDigest = 'sha256:415bbe76d4b15dd5cad4ebfe02d6ba41fcb8ca7068540d101d2bf4dd95c83222'
  const futureFreshUntil = '2999-01-01T00:00:00.000Z'

  const buildRuntimeProofStatus = (overrides: Record<string, unknown> = {}) => ({
    serving_passport_id: 'passport:serving:1',
    admission_passports: [
      {
        admission_passport_id: 'passport:serving:1',
        consumer_class: 'serving',
        decision: 'allow',
        runtime_kit_set_digest: 'runtime-serving',
        required_runtime_kits: ['runtime-kit:serving:1'],
        fresh_until: futureFreshUntil,
      },
      {
        admission_passport_id: 'passport:swarm_plan:1',
        consumer_class: 'swarm_plan',
        decision: 'allow',
        runtime_kit_set_digest: 'runtime-plan',
        required_runtime_kits: ['runtime-kit:collaboration:1'],
        fresh_until: futureFreshUntil,
      },
    ],
    recovery_warrants: [
      {
        recovery_warrant_id: 'recovery-warrant:serving:1',
        execution_class: 'serving',
        admission_passport_id: 'passport:serving:1',
        runtime_kit_digest: 'runtime-serving',
        admitted_image_digest: expectedDigest,
        required_proof_cell_ids: ['runtime-proof-cell:serving:image'],
        projection_watermark_ids: ['projection-watermark:serving:deploy'],
        status: 'sealed',
        active_backlog_seat_count: 0,
        reason_codes: [],
      },
      {
        recovery_warrant_id: 'recovery-warrant:plan:1',
        execution_class: 'plan',
        admission_passport_id: 'passport:swarm_plan:1',
        runtime_kit_digest: 'runtime-plan',
        admitted_image_digest: expectedDigest,
        required_proof_cell_ids: ['runtime-proof-cell:plan:image'],
        projection_watermark_ids: ['projection-watermark:plan:deploy'],
        status: 'sealed',
        active_backlog_seat_count: 0,
        reason_codes: [],
      },
    ],
    runtime_proof_cells: [
      {
        runtime_proof_cell_id: 'runtime-proof-cell:serving:image',
        recovery_warrant_id: 'recovery-warrant:serving:1',
        status: 'healthy',
        required: true,
        expires_at: futureFreshUntil,
      },
      {
        runtime_proof_cell_id: 'runtime-proof-cell:plan:image',
        recovery_warrant_id: 'recovery-warrant:plan:1',
        status: 'healthy',
        required: true,
        expires_at: futureFreshUntil,
      },
    ],
    projection_watermarks: [
      {
        projection_watermark_id: 'projection-watermark:serving:deploy',
        consumer_key: 'deploy_verification',
        recovery_warrant_id: 'recovery-warrant:serving:1',
        source_ref: 'admission-passport:passport:serving:1',
        status: 'fresh',
        expires_at: futureFreshUntil,
        projection_digest: 'projection-serving',
      },
      {
        projection_watermark_id: 'projection-watermark:plan:deploy',
        consumer_key: 'deploy_verification',
        recovery_warrant_id: 'recovery-warrant:plan:1',
        source_ref: 'admission-passport:passport:swarm_plan:1',
        status: 'fresh',
        expires_at: futureFreshUntil,
        projection_digest: 'projection-plan',
      },
    ],
    ...overrides,
  })

  it('extracts expected digest for configured image', () => {
    const source = `images:
  - name: registry.ide-newton.ts.net/lab/jangar
    newTag: "abcd1234"
    digest: sha256:6af34b1781155267ed6821833feb0ee8856b2b08128cb0ac9b0c388615b380fe
  - name: registry.ide-newton.ts.net/lab/other
    newTag: latest
    digest: sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
`

    const digest = __private.extractExpectedDigest(source, 'registry.ide-newton.ts.net/lab/jangar')
    expect(digest).toBe('sha256:6af34b1781155267ed6821833feb0ee8856b2b08128cb0ac9b0c388615b380fe')
  })

  it('parses deployment and sync args', () => {
    const parsed = __private.parseArgs([
      '--namespace',
      'jangar',
      '--deployments',
      'jangar',
      '--require-synced',
      '--expected-revision',
      '0123456789abcdef0123456789abcdef01234567',
      '--expected-revision-mode',
      'ancestor',
      '--health-attempts',
      '10',
      '--health-interval-seconds',
      '5',
      '--digest-attempts',
      '8',
      '--digest-interval-seconds',
      '4',
      '--status-service-namespace',
      'jangar',
      '--status-service-name',
      'jangar',
      '--status-service-port',
      '80',
      '--control-plane-status-namespace',
      'agents',
      '--admission-passport-consumers',
      'serving,swarm_plan',
      '--skip-admission-passport-verification',
      '--skip-runtime-proof-verification',
    ])

    expect(parsed.namespace).toBe('jangar')
    expect(parsed.deployments).toEqual(['jangar'])
    expect(parsed.requireSynced).toBe(true)
    expect(parsed.expectedRevision).toBe('0123456789abcdef0123456789abcdef01234567')
    expect(parsed.expectedRevisionMode).toBe('ancestor')
    expect(parsed.healthAttempts).toBe(10)
    expect(parsed.healthIntervalSeconds).toBe(5)
    expect(parsed.digestAttempts).toBe(8)
    expect(parsed.digestIntervalSeconds).toBe(4)
    expect(parsed.statusServiceNamespace).toBe('jangar')
    expect(parsed.statusServiceName).toBe('jangar')
    expect(parsed.statusServicePort).toBe('80')
    expect(parsed.controlPlaneStatusNamespace).toBe('agents')
    expect(parsed.admissionPassportConsumers).toEqual(['serving', 'swarm_plan'])
    expect(parsed.skipAdmissionPassportVerification).toBe(true)
    expect(parsed.skipRuntimeProofVerification).toBe(true)
  })

  it('builds the control-plane status service proxy path', () => {
    expect(
      __private.buildControlPlaneStatusProxyPath({
        statusServiceNamespace: 'jangar',
        statusServiceName: 'jangar',
        statusServicePort: '80',
        controlPlaneStatusNamespace: 'agents',
      }),
    ).toBe('/api/v1/namespaces/jangar/services/jangar:80/proxy/api/agents/control-plane/status?namespace=agents')
  })

  it('rejects unknown admission passport consumers', () => {
    expect(() => __private.parseAdmissionPassportConsumers('serving,deploy_verify')).toThrow(
      "Unknown admission passport consumer 'deploy_verify'",
    )
  })

  it('accepts runtime image refs that cite the expected rollout digest', () => {
    expect(
      __private.imageRefMatchesExpectedDigest(
        'registry.ide-newton.ts.net/lab/jangar:000d3b97@sha256:415bbe76d4b15dd5cad4ebfe02d6ba41fcb8ca7068540d101d2bf4dd95c83222',
        'sha256:415bbe76d4b15dd5cad4ebfe02d6ba41fcb8ca7068540d101d2bf4dd95c83222',
      ),
    ).toBe(true)
    expect(
      __private.imageRefMatchesExpectedDigest(
        'runtime:local',
        'sha256:415bbe76d4b15dd5cad4ebfe02d6ba41fcb8ca7068540d101d2bf4dd95c83222',
      ),
    ).toBe(false)
  })

  it('verifies allowed passport digests against runtime kits on the promoted image digest', () => {
    const evidence = __private.verifyAdmissionPassportParity({
      status: {
        serving_passport_id: 'passport:serving:1',
        runtime_kits: [
          {
            runtime_kit_id: 'runtime-kit:serving:1',
            image_ref:
              'registry.ide-newton.ts.net/lab/jangar:000d3b97@sha256:415bbe76d4b15dd5cad4ebfe02d6ba41fcb8ca7068540d101d2bf4dd95c83222',
            decision: 'healthy',
            fresh_until: '2999-01-01T00:00:00.000Z',
          },
          {
            runtime_kit_id: 'runtime-kit:collaboration:1',
            image_ref:
              'registry.ide-newton.ts.net/lab/jangar:000d3b97@sha256:415bbe76d4b15dd5cad4ebfe02d6ba41fcb8ca7068540d101d2bf4dd95c83222',
            decision: 'healthy',
            fresh_until: '2999-01-01T00:00:00.000Z',
          },
        ],
        admission_passports: [
          {
            admission_passport_id: 'passport:serving:1',
            consumer_class: 'serving',
            decision: 'allow',
            runtime_kit_set_digest: 'runtime-serving',
            required_runtime_kits: ['runtime-kit:serving:1'],
            fresh_until: '2999-01-01T00:00:00.000Z',
          },
          {
            admission_passport_id: 'passport:swarm_plan:1',
            consumer_class: 'swarm_plan',
            decision: 'allow',
            runtime_kit_set_digest: 'runtime-collaboration',
            required_runtime_kits: ['runtime-kit:collaboration:1'],
            fresh_until: '2999-01-01T00:00:00.000Z',
          },
        ],
      },
      expectedDigest: 'sha256:415bbe76d4b15dd5cad4ebfe02d6ba41fcb8ca7068540d101d2bf4dd95c83222',
      consumers: ['serving', 'swarm_plan'],
      now: new Date('2026-05-06T00:00:00.000Z'),
    })

    expect(evidence.passportIds).toEqual(['passport:serving:1', 'passport:swarm_plan:1'])
    expect(evidence.runtimeKitSetDigests).toEqual(['runtime-serving', 'runtime-collaboration'])
    expect(evidence.runtimeKitIds).toEqual(['runtime-kit:serving:1', 'runtime-kit:collaboration:1'])
  })

  it('fails verification when a required runtime kit is from another image digest', () => {
    expect(() =>
      __private.verifyAdmissionPassportParity({
        status: {
          serving_passport_id: 'passport:serving:1',
          runtime_kits: [
            {
              runtime_kit_id: 'runtime-kit:serving:1',
              image_ref:
                'registry.ide-newton.ts.net/lab/jangar:old@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              decision: 'healthy',
              fresh_until: '2999-01-01T00:00:00.000Z',
            },
          ],
          admission_passports: [
            {
              admission_passport_id: 'passport:serving:1',
              consumer_class: 'serving',
              decision: 'allow',
              runtime_kit_set_digest: 'runtime-serving',
              required_runtime_kits: ['runtime-kit:serving:1'],
              fresh_until: '2999-01-01T00:00:00.000Z',
            },
          ],
        },
        expectedDigest: 'sha256:415bbe76d4b15dd5cad4ebfe02d6ba41fcb8ca7068540d101d2bf4dd95c83222',
        consumers: ['serving'],
        now: new Date('2026-05-06T00:00:00.000Z'),
      }),
    ).toThrow('does not match expected rollout digest')
  })

  it('fails verification when a required passport is held', () => {
    expect(() =>
      __private.verifyAdmissionPassportParity({
        status: {
          serving_passport_id: 'passport:serving:1',
          runtime_kits: [
            {
              runtime_kit_id: 'runtime-kit:serving:1',
              image_ref:
                'registry.ide-newton.ts.net/lab/jangar:000d3b97@sha256:415bbe76d4b15dd5cad4ebfe02d6ba41fcb8ca7068540d101d2bf4dd95c83222',
              decision: 'healthy',
              fresh_until: '2999-01-01T00:00:00.000Z',
            },
          ],
          admission_passports: [
            {
              admission_passport_id: 'passport:serving:1',
              consumer_class: 'serving',
              decision: 'hold',
              reason_codes: ['execution_trust_degraded'],
              runtime_kit_set_digest: 'runtime-serving',
              required_runtime_kits: ['runtime-kit:serving:1'],
              fresh_until: '2999-01-01T00:00:00.000Z',
            },
          ],
        },
        expectedDigest: 'sha256:415bbe76d4b15dd5cad4ebfe02d6ba41fcb8ca7068540d101d2bf4dd95c83222',
        consumers: ['serving'],
        now: new Date('2026-05-06T00:00:00.000Z'),
      }),
    ).toThrow('is not allow')
  })

  it('verifies sealed deployment warrants, proof cells, and deploy watermarks', () => {
    const evidence = __private.verifyRuntimeProofSurfaceParity({
      status: buildRuntimeProofStatus(),
      expectedDigest,
      consumers: ['serving', 'swarm_plan'],
      now: new Date('2026-05-07T00:00:00.000Z'),
    })

    expect(evidence.warrantIds).toEqual(['recovery-warrant:serving:1', 'recovery-warrant:plan:1'])
    expect(evidence.proofCellIds).toEqual(['runtime-proof-cell:serving:image', 'runtime-proof-cell:plan:image'])
    expect(evidence.projectionWatermarkIds).toEqual([
      'projection-watermark:serving:deploy',
      'projection-watermark:plan:deploy',
    ])
  })

  it('fails runtime proof verification when the deploy watermark is missing', () => {
    expect(() =>
      __private.verifyRuntimeProofSurfaceParity({
        status: buildRuntimeProofStatus({
          projection_watermarks: [
            {
              projection_watermark_id: 'projection-watermark:serving:status',
              consumer_key: 'control_plane_status',
              recovery_warrant_id: 'recovery-warrant:serving:1',
              source_ref: 'admission-passport:passport:serving:1',
              status: 'fresh',
              expires_at: futureFreshUntil,
              projection_digest: 'projection-serving',
            },
          ],
        }),
        expectedDigest,
        consumers: ['serving'],
        now: new Date('2026-05-07T00:00:00.000Z'),
      }),
    ).toThrow('Missing deploy verification projection watermark')
  })

  it('fails runtime proof verification when a superseded warrant still has runnable seats', () => {
    const status = buildRuntimeProofStatus()
    const recoveryWarrants = [
      ...(status.recovery_warrants as Record<string, unknown>[]),
      {
        recovery_warrant_id: 'recovery-warrant:plan:old',
        execution_class: 'plan',
        status: 'superseded',
        active_backlog_seat_count: 1,
      },
    ]

    expect(() =>
      __private.verifyRuntimeProofSurfaceParity({
        status: buildRuntimeProofStatus({ recovery_warrants: recoveryWarrants }),
        expectedDigest,
        consumers: ['swarm_plan'],
        now: new Date('2026-05-07T00:00:00.000Z'),
      }),
    ).toThrow('superseded recovery warrant recovery-warrant:plan:old still has 1 active backlog seats')
  })

  it('waits while Argo revision is not the expected revision', () => {
    const waitReason = __private.getArgoWaitReason(
      parseArgoApplicationStatus(
        JSON.stringify({
          status: {
            health: { status: 'Healthy' },
            sync: { status: 'Synced', revision: 'abcdef0123456789abcdef0123456789abcdef01' },
          },
        }),
      ),
      {
        argoApplication: 'jangar',
        argoNamespace: 'argocd',
        deployments: ['jangar'],
        digestAttempts: 1,
        digestIntervalSeconds: 1,
        expectedRevision: 'fedcba9876543210fedcba9876543210fedcba98',
        healthAttempts: 1,
        healthIntervalSeconds: 1,
        imageName: 'registry.ide-newton.ts.net/lab/jangar',
        kustomizationPath: 'argocd/applications/jangar/kustomization.yaml',
        namespace: 'jangar',
        expectedRevisionMode: 'exact',
        requireSynced: true,
        rolloutTimeout: '10m',
      },
      false,
    )

    expect(waitReason).toContain('revision=')
    expect(waitReason).toContain('expected=')
  })

  it('returns no wait reason for synced healthy expected revision', () => {
    const waitReason = __private.getArgoWaitReason(
      parseArgoApplicationStatus(
        JSON.stringify({
          status: {
            health: { status: 'Healthy' },
            sync: { status: 'Synced', revision: '0123456789abcdef0123456789abcdef01234567' },
          },
        }),
      ),
      {
        argoApplication: 'jangar',
        argoNamespace: 'argocd',
        deployments: ['jangar'],
        digestAttempts: 1,
        digestIntervalSeconds: 1,
        expectedRevision: '0123456789abcdef0123456789abcdef01234567',
        healthAttempts: 1,
        healthIntervalSeconds: 1,
        imageName: 'registry.ide-newton.ts.net/lab/jangar',
        kustomizationPath: 'argocd/applications/jangar/kustomization.yaml',
        namespace: 'jangar',
        expectedRevisionMode: 'exact',
        requireSynced: true,
        rolloutTimeout: '10m',
      },
      true,
    )

    expect(waitReason).toBeUndefined()
  })

  it('returns no wait reason when ancestor revision is acceptable', () => {
    const waitReason = __private.getArgoWaitReason(
      parseArgoApplicationStatus(
        JSON.stringify({
          status: {
            health: { status: 'Healthy' },
            sync: { status: 'Synced', revision: 'abcdef0123456789abcdef0123456789abcdef01' },
          },
        }),
      ),
      {
        argoApplication: 'jangar',
        argoNamespace: 'argocd',
        deployments: ['jangar'],
        digestAttempts: 1,
        digestIntervalSeconds: 1,
        expectedRevision: '0123456789abcdef0123456789abcdef01234567',
        expectedRevisionMode: 'ancestor',
        healthAttempts: 1,
        healthIntervalSeconds: 1,
        imageName: 'registry.ide-newton.ts.net/lab/jangar',
        kustomizationPath: 'argocd/applications/jangar/kustomization.yaml',
        namespace: 'jangar',
        requireSynced: true,
        rolloutTimeout: '10m',
      },
      true,
    )

    expect(waitReason).toBeUndefined()
  })

  it('fetches missing revisions before checking ancestry', async () => {
    const expectedRevision = '0123456789abcdef0123456789abcdef01234567'
    const statusRevision = 'abcdef0123456789abcdef0123456789abcdef01'
    const availableRevisions = new Set([expectedRevision])
    const calls: string[] = []

    const runner = async (_command: string, args: string[]) => {
      calls.push(args.join(' '))
      if (args[0] === 'cat-file') {
        const revision = args[2]?.replace(/\^\{commit\}$/, '')
        return { stdout: '', stderr: '', exitCode: revision && availableRevisions.has(revision) ? 0 : 1 }
      }
      if (args[0] === 'fetch') {
        availableRevisions.add(args[4])
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      if (args[0] === 'merge-base') {
        return { stdout: '', stderr: '', exitCode: 0 }
      }

      return { stdout: '', stderr: `unexpected git command: ${args.join(' ')}`, exitCode: 1 }
    }

    const satisfied = await __private.isExpectedRevisionSatisfied(statusRevision, expectedRevision, 'ancestor', runner)

    expect(satisfied).toBe(true)
    expect(calls).toContain(`fetch --no-tags --depth=1 origin ${statusRevision}`)
    expect(calls).toContain(`merge-base --is-ancestor ${expectedRevision} ${statusRevision}`)
  })

  it('fetches main when a newer synced revision is not directly fetchable by sha', async () => {
    const expectedRevision = '0123456789abcdef0123456789abcdef01234567'
    const statusRevision = 'abcdef0123456789abcdef0123456789abcdef01'
    const availableRevisions = new Set([expectedRevision])
    const calls: string[] = []

    const runner = async (_command: string, args: string[]) => {
      calls.push(args.join(' '))
      if (args[0] === 'cat-file') {
        const revision = args[2]?.replace(/\^\{commit\}$/, '')
        return { stdout: '', stderr: '', exitCode: revision && availableRevisions.has(revision) ? 0 : 1 }
      }
      if (args[0] === 'fetch' && args[4] === statusRevision) {
        return { stdout: '', stderr: 'fatal: could not find remote ref', exitCode: 128 }
      }
      if (args[0] === 'fetch' && args[3] === 'main') {
        availableRevisions.add(statusRevision)
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      if (args[0] === 'merge-base') {
        return { stdout: '', stderr: '', exitCode: 0 }
      }

      return { stdout: '', stderr: `unexpected git command: ${args.join(' ')}`, exitCode: 1 }
    }

    const satisfied = await __private.isExpectedRevisionSatisfied(statusRevision, expectedRevision, 'ancestor', runner)

    expect(satisfied).toBe(true)
    expect(calls).toContain(`fetch --no-tags --depth=1 origin ${statusRevision}`)
    expect(calls).toContain('fetch --no-tags origin main')
    expect(calls).toContain(`merge-base --is-ancestor ${expectedRevision} ${statusRevision}`)
  })

  it('deepens fetched synced revision history before rejecting ancestor mode', async () => {
    const expectedRevision = '0123456789abcdef0123456789abcdef01234567'
    const statusRevision = 'abcdef0123456789abcdef0123456789abcdef01'
    const calls: string[] = []
    let historyDeepened = false

    const runner = async (_command: string, args: string[]) => {
      calls.push(args.join(' '))
      if (args[0] === 'cat-file') {
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      if (args[0] === 'fetch' && args[2] === '--deepen=1000' && args[4] === statusRevision) {
        historyDeepened = true
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      if (args[0] === 'merge-base') {
        return { stdout: '', stderr: '', exitCode: historyDeepened ? 0 : 1 }
      }

      return { stdout: '', stderr: `unexpected git command: ${args.join(' ')}`, exitCode: 1 }
    }

    const satisfied = await __private.isExpectedRevisionSatisfied(statusRevision, expectedRevision, 'ancestor', runner)

    expect(satisfied).toBe(true)
    expect(calls).toContain(`fetch --no-tags --deepen=1000 origin ${statusRevision}`)
    expect(
      calls.filter((call) => call === `merge-base --is-ancestor ${expectedRevision} ${statusRevision}`),
    ).toHaveLength(2)
  })

  it('keeps waiting instead of throwing when an unknown revision cannot be fetched', async () => {
    const expectedRevision = '0123456789abcdef0123456789abcdef01234567'
    const statusRevision = 'abcdef0123456789abcdef0123456789abcdef01'
    const calls: string[] = []

    const runner = async (_command: string, args: string[]) => {
      calls.push(args.join(' '))
      return { stdout: '', stderr: 'fatal: Not a valid commit name', exitCode: 128 }
    }

    const satisfied = await __private.isExpectedRevisionSatisfied(statusRevision, expectedRevision, 'ancestor', runner)

    expect(satisfied).toBe(false)
    expect(calls).not.toContain(`merge-base --is-ancestor ${expectedRevision} ${statusRevision}`)
  })

  it('prefers the last deployed revision over the moving sync target', () => {
    const status = parseArgoApplicationStatus(
      JSON.stringify({
        status: {
          health: { status: 'Healthy' },
          history: [{ revision: 'de84c71d8719cd781fe63e53e80cacd2642ea9e3' }],
          operationState: {
            phase: 'Succeeded',
            syncResult: {
              revision: 'de84c71d8719cd781fe63e53e80cacd2642ea9e3',
            },
          },
          sync: {
            status: 'Synced',
            revision: 'd65e7094ab93b1a9a5ae002c1eccce2a0151fae8',
          },
        },
      }),
    )

    expect(status.revision).toBe('de84c71d8719cd781fe63e53e80cacd2642ea9e3')
    expect(status.desiredRevision).toBe('d65e7094ab93b1a9a5ae002c1eccce2a0151fae8')
  })

  it('uses the current sync revision instead of stale history after a failed operation', () => {
    const status = parseArgoApplicationStatus(
      JSON.stringify({
        status: {
          health: { status: 'Healthy' },
          history: [{ revision: '8958a06b34ee546e9869ce02a6d4cbc1f97c0a8a' }],
          operationState: {
            phase: 'Failed',
            syncResult: {
              revision: '400e20256b73e02a9dff60e0d2f238366b0e09a1',
            },
          },
          sync: {
            status: 'Synced',
            revision: 'f27b9359a263201cb875633f29a1f36253d823ba',
          },
        },
      }),
    )

    expect(status.revision).toBe('f27b9359a263201cb875633f29a1f36253d823ba')
    expect(status.desiredRevision).toBe('f27b9359a263201cb875633f29a1f36253d823ba')
  })
})
