import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/feature-flags', () => ({
  resolveBooleanFeatureToggle: vi.fn(async () => true),
}))

import { resolveBooleanFeatureToggle } from '~/server/feature-flags'
import type { KubernetesClient } from '~/server/primitives-kube'
import { __test__ } from '~/server/supporting-primitives-controller'

describe('supporting primitives controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-20T00:00:00Z'))
    delete process.env.JANGAR_SUPPORTING_CONTROLLER_ENABLED
    delete process.env.JANGAR_SUPPORTING_CONTROLLER_ENABLED_FLAG_KEY
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sets standard conditions and updatedAt for invalid tools', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const kube = { applyStatus } as unknown as KubernetesClient

    const tool = {
      apiVersion: 'tools.proompteng.ai/v1alpha1',
      kind: 'Tool',
      metadata: { name: 'bad-tool', namespace: 'agents', generation: 1 },
      spec: {},
    }

    await __test__.reconcileTool(kube, tool)

    expect(applyStatus).toHaveBeenCalledTimes(1)
    const payload = applyStatus.mock.calls[0]?.[0] as { status?: Record<string, unknown> }
    const status = payload.status ?? {}

    expect(status.updatedAt).toBe('2026-01-20T00:00:00.000Z')

    const conditions = Array.isArray(status.conditions) ? status.conditions : []
    const ready = conditions.find((condition) => condition.type === 'Ready')
    const progressing = conditions.find((condition) => condition.type === 'Progressing')
    const degraded = conditions.find((condition) => condition.type === 'Degraded')

    expect(ready?.status).toBe('False')
    expect(progressing?.status).toBe('False')
    expect(degraded?.status).toBe('True')
  })

  it('resolves startup gate from feature flags with env fallback default', async () => {
    const previousNodeEnv = process.env.NODE_ENV
    try {
      process.env.NODE_ENV = 'production'
      process.env.JANGAR_SUPPORTING_CONTROLLER_ENABLED = 'false'
      const resolveBooleanFeatureToggleMock = vi.mocked(resolveBooleanFeatureToggle)
      resolveBooleanFeatureToggleMock.mockResolvedValueOnce(true)

      const enabled = await __test__.shouldStartWithFeatureFlag()

      expect(enabled).toBe(true)
      expect(resolveBooleanFeatureToggleMock).toHaveBeenCalledWith({
        key: 'jangar.supporting_controller.enabled',
        keyEnvVar: 'JANGAR_SUPPORTING_CONTROLLER_ENABLED_FLAG_KEY',
        fallbackEnvVar: 'JANGAR_SUPPORTING_CONTROLLER_ENABLED',
        defaultValue: false,
      })
    } finally {
      process.env.NODE_ENV = previousNodeEnv
    }
  })
})
