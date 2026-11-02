import { describe, expect, it } from 'bun:test'

import { parseArgoApplicationStatus } from '../../shared/argo'
import { __private } from '../verify-deployment'

describe('verify-deployment', () => {
  const agentsRuntimeDigest = 'sha256:9bb9bf86d0ebffceae8424d68e7b20db62ba395f56dcf3923a2f58c5e0b391a5'
  const futureFreshUntil = '2999-01-01T00:00:00.000Z'

  const buildAuthorityProvenanceSettlement = (overrides: Record<string, unknown> = {}) => ({
    schema_version: 'jangar.authority-provenance-settlement.v1',
    settlement_id: 'authority-provenance-settlement:test',
    evidence_mode: 'shadow',
    settlement_state: 'repairable_split',
    winning_authority: 'controller_heartbeat',
    fresh_until: futureFreshUntil,
    rollback_target: 'JANGAR_AUTHORITY_PROVENANCE_SETTLEMENT_MODE=observe',
    handoff_summary: 'authority repairable_split; winner=controller_heartbeat',
    action_class_decisions: [
      {
        action_class: 'deploy_widen',
        decision: 'hold',
        reason_codes: ['source_rollout_truth_not_converged'],
      },
      {
        action_class: 'merge_ready',
        decision: 'hold',
        reason_codes: ['source_rollout_truth_not_converged'],
      },
    ],
    reentry_windows: [],
    ...overrides,
  })

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
      {
        admission_passport_id: 'passport:swarm_implement:1',
        consumer_class: 'swarm_implement',
        decision: 'allow',
        runtime_kit_set_digest: 'runtime-implement',
        required_runtime_kits: ['runtime-kit:collaboration:1'],
        fresh_until: futureFreshUntil,
      },
      {
        admission_passport_id: 'passport:swarm_verify:1',
        consumer_class: 'swarm_verify',
        decision: 'allow',
        runtime_kit_set_digest: 'runtime-verify',
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
        admitted_image_digest: agentsRuntimeDigest,
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
        admitted_image_digest: agentsRuntimeDigest,
        required_proof_cell_ids: ['runtime-proof-cell:plan:image'],
        projection_watermark_ids: ['projection-watermark:plan:deploy'],
        status: 'sealed',
        active_backlog_seat_count: 0,
        reason_codes: [],
      },
      {
        recovery_warrant_id: 'recovery-warrant:implement:1',
        execution_class: 'implement',
        admission_passport_id: 'passport:swarm_implement:1',
        runtime_kit_digest: 'runtime-implement',
        admitted_image_digest: agentsRuntimeDigest,
        required_proof_cell_ids: ['runtime-proof-cell:implement:image'],
        projection_watermark_ids: ['projection-watermark:implement:deploy'],
        status: 'sealed',
        active_backlog_seat_count: 0,
        reason_codes: [],
      },
      {
        recovery_warrant_id: 'recovery-warrant:verify:1',
        execution_class: 'verify',
        admission_passport_id: 'passport:swarm_verify:1',
        runtime_kit_digest: 'runtime-verify',
        admitted_image_digest: agentsRuntimeDigest,
        required_proof_cell_ids: ['runtime-proof-cell:verify:image'],
        projection_watermark_ids: ['projection-watermark:verify:deploy'],
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
      {
        runtime_proof_cell_id: 'runtime-proof-cell:implement:image',
        recovery_warrant_id: 'recovery-warrant:implement:1',
        status: 'healthy',
        required: true,
        expires_at: futureFreshUntil,
      },
      {
        runtime_proof_cell_id: 'runtime-proof-cell:verify:image',
        recovery_warrant_id: 'recovery-warrant:verify:1',
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
      {
        projection_watermark_id: 'projection-watermark:implement:deploy',
        consumer_key: 'deploy_verification',
        recovery_warrant_id: 'recovery-warrant:implement:1',
        source_ref: 'admission-passport:passport:swarm_implement:1',
        status: 'fresh',
        expires_at: futureFreshUntil,
        projection_digest: 'projection-implement',
      },
      {
        projection_watermark_id: 'projection-watermark:verify:deploy',
        consumer_key: 'deploy_verification',
        recovery_warrant_id: 'recovery-warrant:verify:1',
        source_ref: 'admission-passport:passport:swarm_verify:1',
        status: 'fresh',
        expires_at: futureFreshUntil,
        projection_digest: 'projection-verify',
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
      '--control-plane-service-namespace',
      'agents',
      '--control-plane-service-name',
      'agents',
      '--control-plane-service-port',
      '80',
      '--control-plane-status-namespace',
      'agents',
      '--admission-passport-consumers',
      'serving,swarm_plan',
      '--skip-admission-passport-verification',
      '--skip-runtime-proof-verification',
      '--skip-authority-provenance-verification',
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
    expect(parsed.controlPlaneServiceNamespace).toBe('agents')
    expect(parsed.controlPlaneServiceName).toBe('agents')
    expect(parsed.controlPlaneServicePort).toBe('80')
    expect(parsed.controlPlaneStatusNamespace).toBe('agents')
    expect(parsed.admissionPassportConsumers).toEqual(['serving', 'swarm_plan'])
    expect(parsed.skipAdmissionPassportVerification).toBe(true)
    expect(parsed.skipRuntimeProofVerification).toBe(true)
    expect(parsed.skipAuthorityProvenanceVerification).toBe(true)
  })

  it('builds the control-plane status service proxy path', () => {
    expect(
      __private.buildControlPlaneStatusProxyPath({
        controlPlaneServiceNamespace: 'agents',
        controlPlaneServiceName: 'agents',
        controlPlaneServicePort: '80',
        controlPlaneStatusNamespace: 'agents',
      }),
    ).toBe('/api/v1/namespaces/agents/services/agents:80/proxy/v1/control-plane/status?namespace=agents')
  })

  it('rejects unknown admission passport consumers', () => {
    expect(() => __private.parseAdmissionPassportConsumers('serving,deploy_verify')).toThrow(
      "Unknown admission passport consumer 'deploy_verify'",
    )
  })

  it('verifies allowed passport digests against healthy referenced runtime kits', () => {
    const evidence = __private.verifyAdmissionPassportParity({
      status: {
        serving_passport_id: 'passport:serving:1',
        runtime_kits: [
          {
            runtime_kit_id: 'runtime-kit:serving:1',
            image_ref:
              'registry.ide-newton.ts.net/lab/agents-control-plane:41c9e32e@sha256:9bb9bf86d0ebffceae8424d68e7b20db62ba395f56dcf3923a2f58c5e0b391a5',
            decision: 'healthy',
            fresh_until: '2999-01-01T00:00:00.000Z',
          },
          {
            runtime_kit_id: 'runtime-kit:collaboration:1',
            image_ref:
              'registry.ide-newton.ts.net/lab/agents-control-plane:41c9e32e@sha256:9bb9bf86d0ebffceae8424d68e7b20db62ba395f56dcf3923a2f58c5e0b391a5',
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
      consumers: ['serving', 'swarm_plan'],
      now: new Date('2026-05-06T00:00:00.000Z'),
    })

    expect(evidence.passportIds).toEqual(['passport:serving:1', 'passport:swarm_plan:1'])
    expect(evidence.runtimeKitSetDigests).toEqual(['runtime-serving', 'runtime-collaboration'])
    expect(evidence.runtimeKitIds).toEqual(['runtime-kit:serving:1', 'runtime-kit:collaboration:1'])
    expect(evidence.runtimeImageRefs).toEqual([
      'registry.ide-newton.ts.net/lab/agents-control-plane:41c9e32e@sha256:9bb9bf86d0ebffceae8424d68e7b20db62ba395f56dcf3923a2f58c5e0b391a5',
    ])
  })

  it('fails verification when a required runtime kit omits its image ref', () => {
    expect(() =>
      __private.verifyAdmissionPassportParity({
        status: {
          serving_passport_id: 'passport:serving:1',
          runtime_kits: [
            {
              runtime_kit_id: 'runtime-kit:serving:1',
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
        consumers: ['serving'],
        now: new Date('2026-05-06T00:00:00.000Z'),
      }),
    ).toThrow('does not include image_ref')
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
        consumers: ['serving'],
        now: new Date('2026-05-06T00:00:00.000Z'),
      }),
    ).toThrow('is not allow')
  })

  it('verifies sealed deployment warrants, proof cells, and deploy watermarks', () => {
    const evidence = __private.verifyRuntimeProofSurfaceParity({
      status: buildRuntimeProofStatus(),
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

  it('includes verify warrants in the default deploy proof gate', () => {
    const evidence = __private.verifyRuntimeProofSurfaceParity({
      status: buildRuntimeProofStatus(),
      consumers: __private.defaultAdmissionPassportConsumers,
      now: new Date('2026-05-07T00:00:00.000Z'),
    })

    expect(__private.defaultAdmissionPassportConsumers).toEqual([
      'serving',
      'swarm_plan',
      'swarm_implement',
      'swarm_verify',
    ])
    expect(evidence.warrantIds).toEqual([
      'recovery-warrant:serving:1',
      'recovery-warrant:plan:1',
      'recovery-warrant:implement:1',
      'recovery-warrant:verify:1',
    ])
    expect(evidence.projectionWatermarkIds).toContain('projection-watermark:verify:deploy')
  })

  it('fails the default deploy proof gate when verify warrant parity is missing', () => {
    const status = buildRuntimeProofStatus()
    const recoveryWarrants = (status.recovery_warrants as Record<string, unknown>[]).filter(
      (warrant) => warrant.recovery_warrant_id !== 'recovery-warrant:verify:1',
    )

    expect(() =>
      __private.verifyRuntimeProofSurfaceParity({
        status: { ...status, recovery_warrants: recoveryWarrants },
        consumers: __private.defaultAdmissionPassportConsumers,
        now: new Date('2026-05-07T00:00:00.000Z'),
      }),
    ).toThrow('Missing verify recovery warrant for admission passport passport:swarm_verify:1')
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
        consumers: ['serving'],
        now: new Date('2026-05-07T00:00:00.000Z'),
      }),
    ).toThrow('Missing deploy verification projection watermark')
  })

  it('fails runtime proof verification when a recovery warrant omits the admitted runtime image digest', () => {
    const status = buildRuntimeProofStatus()
    const recoveryWarrants = (status.recovery_warrants as Record<string, unknown>[]).map((warrant) =>
      warrant.recovery_warrant_id === 'recovery-warrant:serving:1'
        ? { ...warrant, admitted_image_digest: null }
        : warrant,
    )

    expect(() =>
      __private.verifyRuntimeProofSurfaceParity({
        status: buildRuntimeProofStatus({ recovery_warrants: recoveryWarrants }),
        consumers: ['serving'],
        now: new Date('2026-05-07T00:00:00.000Z'),
      }),
    ).toThrow('Recovery warrant recovery-warrant:serving:1 is missing admitted_image_digest')
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
        consumers: ['swarm_plan'],
        now: new Date('2026-05-07T00:00:00.000Z'),
      }),
    ).toThrow('superseded recovery warrant recovery-warrant:plan:old still has 1 active backlog seats')
  })

  it('verifies authority provenance settlement in shadow mode without failing held deploy decisions', () => {
    const evidence = __private.verifyAuthorityProvenanceSettlement({
      status: {
        authority_provenance_settlement: buildAuthorityProvenanceSettlement(),
      },
      enforceDecisions: false,
      now: new Date('2026-05-07T00:00:00.000Z'),
    })

    expect(evidence).toMatchObject({
      settlementId: 'authority-provenance-settlement:test',
      evidenceMode: 'shadow',
      settlementState: 'repairable_split',
      deployWidenDecision: 'hold',
      mergeReadyDecision: 'hold',
      reentryWindowCount: 0,
    })
  })

  it('fails authority provenance verification when enforcement is enabled and deploy widening is held', () => {
    expect(() =>
      __private.verifyAuthorityProvenanceSettlement({
        status: {
          authority_provenance_settlement: buildAuthorityProvenanceSettlement({ evidence_mode: 'enforce' }),
        },
        enforceDecisions: false,
        now: new Date('2026-05-07T00:00:00.000Z'),
      }),
    ).toThrow('Authority provenance deploy_widen is not allow')
  })

  it('fails authority provenance verification when the settlement field is missing', () => {
    expect(() =>
      __private.verifyAuthorityProvenanceSettlement({
        status: {},
        enforceDecisions: false,
        now: new Date('2026-05-07T00:00:00.000Z'),
      }),
    ).toThrow('did not include authority_provenance_settlement')
  })

  it('fails authority provenance verification when the evidence mode is invalid', () => {
    expect(() =>
      __private.verifyAuthorityProvenanceSettlement({
        status: {
          authority_provenance_settlement: buildAuthorityProvenanceSettlement({ evidence_mode: 'unknown' }),
        },
        enforceDecisions: false,
        now: new Date('2026-05-07T00:00:00.000Z'),
      }),
    ).toThrow('invalid evidence_mode')
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
