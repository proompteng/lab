import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { buildRuntimeAdmissionSnapshot } from '~/server/control-plane-runtime-admission'

const HULY_API_SCRIPT_PATH = fileURLToPath(
  new URL('../../../../../skills/huly-api/scripts/huly-api.py', import.meta.url),
)
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
  afterEach(() => {
    resetEnv()
  })

  it('accepts HULY_BASE_URL when HULY_API_BASE_URL is unset', () => {
    delete process.env.HULY_API_BASE_URL
    process.env.HULY_BASE_URL = 'https://huly.example.test'

    const snapshot = buildRuntimeAdmissionSnapshot({
      worktree: REPO_ROOT,
      pythonBin: process.execPath,
      hulyApiScriptPath: HULY_API_SCRIPT_PATH,
    })

    const collaborationKit = snapshot.runtimeKits.find((kit) => kit.kit_class === 'collaboration')
    expect(collaborationKit).toBeDefined()
    expect(collaborationKit?.decision).toBe('healthy')
    expect(collaborationKit?.reason_codes).not.toContain('runtime_kit_component_missing:huly_api_base_url')

    const baseUrlComponent = collaborationKit?.components.find(
      (component) => component.component_kind === 'service_url',
    )
    expect(baseUrlComponent).toMatchObject({
      component_ref: 'HULY_API_BASE_URL|HULY_BASE_URL',
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
})
