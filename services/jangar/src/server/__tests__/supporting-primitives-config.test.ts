import { describe, expect, it } from 'vitest'

import { resolveSupportingPrimitivesConfig } from '../supporting-primitives-config'

describe('resolveSupportingPrimitivesConfig', () => {
  it('defaults runtime admission status to the Agents status contract without legacy projections', () => {
    const config = resolveSupportingPrimitivesConfig({})

    expect(config.runtimeAdmissionStatusUrl).toBe(
      'http://agents.agents.svc.cluster.local/api/agents/control-plane/status',
    )
  })

  it('keeps explicit runtime admission URLs configurable for Jangar domain consumers', () => {
    const config = resolveSupportingPrimitivesConfig({
      JANGAR_RUNTIME_ADMISSION_STATUS_URL:
        'http://jangar.jangar.svc.cluster.local/api/control-plane/status?view=schedule-runner',
    })

    expect(config.runtimeAdmissionStatusUrl).toBe(
      'http://jangar.jangar.svc.cluster.local/api/control-plane/status?view=schedule-runner',
    )
  })

  it('does not retain generic Agent runner image ownership in Jangar config', () => {
    const config = resolveSupportingPrimitivesConfig({
      JANGAR_AGENT_RUNNER_IMAGE: 'registry.example/old-jangar-runner:tag',
      JANGAR_AGENT_IMAGE: 'registry.example/old-jangar-agent:tag',
    })

    expect('defaultWorkloadImage' in config).toBe(false)
  })
})
