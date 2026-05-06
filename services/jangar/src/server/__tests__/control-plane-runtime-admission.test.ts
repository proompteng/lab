import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { buildRuntimeAdmissionSnapshot } from '~/server/control-plane-runtime-admission'

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))

const ORIGINAL_ENV = { ...process.env }

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
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
    resetEnv()
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
    expect(collaborationKit?.subject_ref).toBe('jangar:codex:nats-collaboration')
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

  it('holds collaboration admission while degraded authority keeps serving non-blocking', async () => {
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
        reason: 'requirements are degraded on jangar-control-plane: pending=5',
        last_evaluated_at: '2026-03-21T00:30:01.000Z',
        blocking_windows: [],
        evidence_summary: ['requirements pending=5'],
      },
    })

    expect(snapshot.admissionPassports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          consumer_class: 'serving',
          decision: 'degrade',
          reason_codes: expect.arrayContaining(['execution_trust_degraded']),
        }),
        expect.objectContaining({
          consumer_class: 'swarm_plan',
          decision: 'hold',
          reason_codes: expect.arrayContaining(['execution_trust_degraded']),
        }),
        expect.objectContaining({
          consumer_class: 'swarm_implement',
          decision: 'hold',
          reason_codes: expect.arrayContaining(['execution_trust_degraded']),
        }),
        expect.objectContaining({
          consumer_class: 'swarm_verify',
          decision: 'hold',
          reason_codes: expect.arrayContaining(['execution_trust_degraded']),
        }),
      ]),
    )
  })
})
