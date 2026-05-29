import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { buildRuntimeAdmissionSnapshot } from '../control-plane-runtime-admission'
import { resolveRuntimeAdmissionConfig } from '../runtime-admission-config'

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))

const ORIGINAL_ENV = { ...process.env }
const ORIGINAL_CWD = process.cwd()

const resetEnv = () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key]
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value
  }
}

describe('buildRuntimeAdmissionSnapshot', () => {
  let tempDir: string | undefined

  afterEach(async () => {
    process.chdir(ORIGINAL_CWD)
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
    resetEnv()
  })

  it('uses the deployed Agents image as the runtime image fallback', () => {
    delete process.env.AGENTS_RUNTIME_IMAGE
    delete process.env.IMAGE_REF
    process.env.AGENTS_IMAGE = 'registry.example.com/lab/agents-control-plane:abc123@sha256:'.concat('a'.repeat(64))

    expect(resolveRuntimeAdmissionConfig().runtimeImage).toBe(process.env.AGENTS_IMAGE)
  })

  it('accepts NATS_URL and NATS helper runtime components for collaboration admission', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'runtime-admission-'))
    const binDir = join(tempDir, 'bin')
    await mkdir(binDir, { recursive: true })
    const natsPath = join(binDir, 'nats')
    await writeFile(natsPath, '#!/usr/bin/env bash\nexit 0\n', 'utf8')
    await chmod(natsPath, 0o755)
    process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`
    process.env.NATS_URL = 'nats://nats.nats.svc.cluster.local:4222'

    const snapshot = buildRuntimeAdmissionSnapshot({
      worktree: REPO_ROOT,
      natsUrl: 'nats://nats.nats.svc.cluster.local:4222',
    })

    const collaborationKit = snapshot.runtimeKits.find((kit) => kit.kit_class === 'collaboration')
    expect(collaborationKit).toBeDefined()
    expect(collaborationKit?.decision).toBe('healthy')
    expect(collaborationKit?.subject_ref).toBe('agents:codex:nats-collaboration')
    expect(collaborationKit?.reason_codes).not.toContain('runtime_kit_component_missing:nats_url')

    expect(collaborationKit?.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          component_ref: expect.stringContaining('codex-nats-publish'),
          present: true,
          reason_code: null,
        }),
        expect.objectContaining({
          component_ref: expect.stringContaining('codex-nats-soak'),
          present: true,
          reason_code: null,
        }),
        expect.objectContaining({
          component_ref: 'nats',
          present: true,
          reason_code: null,
        }),
      ]),
    )

    const natsUrlComponent = collaborationKit?.components.find((component) => component.component_ref === 'NATS_URL')
    expect(natsUrlComponent).toMatchObject({
      component_ref: 'NATS_URL',
      present: true,
      reason_code: null,
    })

    expect(snapshot.admissionPassports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          consumer_class: 'swarm_plan',
          decision: 'allow',
        }),
      ]),
    )
    expect(snapshot.recoveryWarrants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          execution_class: 'plan',
          status: 'sealed',
          admission_passport_id: expect.stringContaining('passport:swarm_plan:'),
        }),
      ]),
    )
    expect(snapshot.runtimeProofCells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          proof_kind: 'helper_asset',
          proof_subject: expect.stringContaining('codex-nats-publish'),
          status: 'healthy',
        }),
        expect.objectContaining({
          proof_kind: 'config_digest',
          proof_subject: 'service_url:NATS_URL',
          status: 'healthy',
        }),
      ]),
    )
    expect(snapshot.projectionWatermarks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          consumer_key: 'deploy_verification',
          status: 'fresh',
        }),
      ]),
    )
  })

  it('blocks collaboration admission when the NATS CLI path is present but not executable', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'runtime-admission-'))
    const binDir = join(tempDir, 'bin')
    await mkdir(binDir, { recursive: true })
    const natsPath = join(binDir, 'nats')
    await writeFile(natsPath, '#!/usr/bin/env bash\nexit 0\n', 'utf8')
    await chmod(natsPath, 0o644)
    process.env.PATH = binDir
    process.env.NATS_URL = 'nats://nats.nats.svc.cluster.local:4222'

    const snapshot = buildRuntimeAdmissionSnapshot({
      worktree: REPO_ROOT,
      natsUrl: 'nats://nats.nats.svc.cluster.local:4222',
    })

    const collaborationKit = snapshot.runtimeKits.find((kit) => kit.kit_class === 'collaboration')
    expect(collaborationKit).toMatchObject({
      decision: 'blocked',
      reason_codes: expect.arrayContaining(['runtime_kit_component_missing:nats_cli']),
    })
    expect(collaborationKit?.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          component_ref: 'nats',
          present: false,
          reason_code: 'runtime_kit_component_missing:nats_cli',
          evidence_ref: 'nats',
        }),
      ]),
    )

    expect(snapshot.admissionPassports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          consumer_class: 'swarm_implement',
          decision: 'block',
          reason_codes: expect.arrayContaining(['runtime_kit_component_missing:nats_cli']),
        }),
      ]),
    )
  })

  it('blocks collaboration admission when a resolved Codex NATS helper is not executable', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'runtime-admission-'))
    const scriptsDir = join(tempDir, 'packages', 'cx-tools', 'src', 'cli')
    const binDir = join(tempDir, 'bin')
    await mkdir(scriptsDir, { recursive: true })
    await mkdir(binDir, { recursive: true })

    const natsPath = join(binDir, 'nats')
    await writeFile(natsPath, '#!/usr/bin/env bash\nexit 0\n', 'utf8')
    await chmod(natsPath, 0o755)

    const publishPath = join(scriptsDir, 'codex-nats-publish.ts')
    const soakPath = join(scriptsDir, 'codex-nats-soak.ts')
    await writeFile(publishPath, '#!/usr/bin/env bun\n', 'utf8')
    await writeFile(soakPath, '#!/usr/bin/env bun\n', 'utf8')
    await chmod(publishPath, 0o644)
    await chmod(soakPath, 0o755)

    process.chdir(tempDir)
    process.env.PATH = binDir
    process.env.NATS_URL = 'nats://nats.nats.svc.cluster.local:4222'

    const snapshot = buildRuntimeAdmissionSnapshot({
      worktree: tempDir,
      natsUrl: 'nats://nats.nats.svc.cluster.local:4222',
    })

    const collaborationKit = snapshot.runtimeKits.find((kit) => kit.kit_class === 'collaboration')
    expect(collaborationKit).toMatchObject({
      decision: 'blocked',
      reason_codes: expect.arrayContaining(['runtime_kit_component_missing:codex_nats_publish']),
    })
    expect(collaborationKit?.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          component_ref: expect.stringContaining('codex-nats-publish.ts'),
          present: false,
          reason_code: 'runtime_kit_component_missing:codex_nats_publish',
        }),
      ]),
    )

    expect(snapshot.admissionPassports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          consumer_class: 'swarm_implement',
          decision: 'block',
          reason_codes: expect.arrayContaining(['runtime_kit_component_missing:codex_nats_publish']),
        }),
      ]),
    )
    expect(snapshot.runtimeProofCells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          proof_kind: 'helper_asset',
          proof_subject: expect.stringContaining('codex-nats-publish.ts'),
          status: 'missing',
          reason_codes: expect.arrayContaining(['runtime_kit_component_missing:codex_nats_publish']),
        }),
      ]),
    )
    expect(snapshot.recoveryWarrants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          execution_class: 'implement',
          status: 'broken',
          reason_codes: expect.arrayContaining(['runtime_kit_component_missing:codex_nats_publish']),
        }),
      ]),
    )
    expect(snapshot.projectionWatermarks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recovery_warrant_id: expect.stringContaining('recovery-warrant:implement:'),
          status: 'degraded',
          reason_codes: expect.arrayContaining(['runtime_kit_component_missing:codex_nats_publish']),
        }),
      ]),
    )
  })

  it('keeps proof-surface ids stable across freshness refreshes', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'runtime-admission-'))
    const binDir = join(tempDir, 'bin')
    await mkdir(binDir, { recursive: true })
    const natsPath = join(binDir, 'nats')
    await writeFile(natsPath, '#!/usr/bin/env bash\nexit 0\n', 'utf8')
    await chmod(natsPath, 0o755)
    process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`
    process.env.NATS_URL = 'nats://nats.nats.svc.cluster.local:4222'

    const first = buildRuntimeAdmissionSnapshot({
      now: new Date('2026-01-20T00:00:00.000Z'),
      worktree: REPO_ROOT,
      natsUrl: 'nats://nats.nats.svc.cluster.local:4222',
    })
    const second = buildRuntimeAdmissionSnapshot({
      now: new Date('2026-01-20T00:02:00.000Z'),
      worktree: REPO_ROOT,
      natsUrl: 'nats://nats.nats.svc.cluster.local:4222',
    })

    const firstPlanPassport = first.admissionPassports.find((passport) => passport.consumer_class === 'swarm_plan')
    const secondPlanPassport = second.admissionPassports.find((passport) => passport.consumer_class === 'swarm_plan')
    expect(firstPlanPassport?.admission_passport_id).toBe(secondPlanPassport?.admission_passport_id)
    expect(firstPlanPassport?.fresh_until).not.toBe(secondPlanPassport?.fresh_until)

    const firstPlanWarrant = first.recoveryWarrants.find((warrant) => warrant.execution_class === 'plan')
    const secondPlanWarrant = second.recoveryWarrants.find((warrant) => warrant.execution_class === 'plan')
    expect(firstPlanWarrant?.recovery_warrant_id).toBe(secondPlanWarrant?.recovery_warrant_id)
    expect(firstPlanWarrant?.recovery_epoch_id).toBe(secondPlanWarrant?.recovery_epoch_id)
    expect(firstPlanWarrant?.required_proof_cell_ids).toEqual(secondPlanWarrant?.required_proof_cell_ids)

    const firstDeployWatermark = first.projectionWatermarks.find(
      (watermark) =>
        watermark.consumer_key === 'deploy_verification' &&
        watermark.recovery_warrant_id === firstPlanWarrant?.recovery_warrant_id,
    )
    const secondDeployWatermark = second.projectionWatermarks.find(
      (watermark) =>
        watermark.consumer_key === 'deploy_verification' &&
        watermark.recovery_warrant_id === secondPlanWarrant?.recovery_warrant_id,
    )
    expect(firstDeployWatermark?.projection_watermark_id).toBe(secondDeployWatermark?.projection_watermark_id)
    expect(firstDeployWatermark?.expires_at).not.toBe(secondDeployWatermark?.expires_at)
  })

  it('keeps degraded execution trust non-blocking so stage schedules can recover', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'runtime-admission-'))
    const binDir = join(tempDir, 'bin')
    await mkdir(binDir, { recursive: true })
    const natsPath = join(binDir, 'nats')
    await writeFile(natsPath, '#!/usr/bin/env bash\nexit 0\n', 'utf8')
    await chmod(natsPath, 0o755)
    process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`
    process.env.NATS_URL = 'nats://nats.nats.svc.cluster.local:4222'

    const snapshot = buildRuntimeAdmissionSnapshot({
      worktree: REPO_ROOT,
      natsUrl: 'nats://nats.nats.svc.cluster.local:4222',
      executionTrust: {
        status: 'degraded',
        reason: 'requirements are degraded on agents-control-plane: pending=5',
        last_evaluated_at: '2026-03-21T00:30:01.000Z',
        blocking_windows: [],
        evidence_summary: ['requirements pending=5'],
      },
    })

    expect(snapshot.admissionPassports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          consumer_class: 'serving',
          decision: 'allow',
          reason_codes: expect.arrayContaining(['execution_trust_degraded']),
          required_subjects: expect.arrayContaining([
            expect.objectContaining({
              subject_kind: 'authority',
              decision: 'allow',
            }),
          ]),
        }),
        expect.objectContaining({
          consumer_class: 'swarm_plan',
          decision: 'allow',
          reason_codes: expect.arrayContaining(['execution_trust_degraded']),
          required_subjects: expect.arrayContaining([
            expect.objectContaining({
              subject_kind: 'authority',
              decision: 'allow',
            }),
          ]),
        }),
        expect.objectContaining({
          consumer_class: 'swarm_implement',
          decision: 'allow',
          reason_codes: expect.arrayContaining(['execution_trust_degraded']),
        }),
        expect.objectContaining({
          consumer_class: 'swarm_verify',
          decision: 'allow',
          reason_codes: expect.arrayContaining(['execution_trust_degraded']),
        }),
      ]),
    )
    expect(snapshot.recoveryWarrants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          execution_class: 'plan',
          status: 'sealed',
          reason_codes: expect.arrayContaining(['execution_trust_degraded']),
        }),
        expect.objectContaining({
          execution_class: 'implement',
          status: 'sealed',
          reason_codes: expect.arrayContaining(['execution_trust_degraded']),
        }),
      ]),
    )
  })
})
