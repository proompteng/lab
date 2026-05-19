import { describe, expect, it } from 'vitest'

import { resolveSupportingPrimitivesConfig } from '../supporting-primitives-config'

describe('resolveSupportingPrimitivesConfig', () => {
  it('defaults schedule-runner admission to the Agents status contract without legacy projections', () => {
    const config = resolveSupportingPrimitivesConfig({})

    expect(config.scheduleRunnerAdmissionStatusUrl).toBe(
      'http://agents.agents.svc.cluster.local/api/agents/control-plane/status',
    )
  })

  it('keeps explicit schedule-runner admission URLs configurable for Jangar domain consumers', () => {
    const config = resolveSupportingPrimitivesConfig({
      JANGAR_SCHEDULE_RUNNER_ADMISSION_STATUS_URL:
        'http://jangar.jangar.svc.cluster.local/api/control-plane/status?view=schedule-runner',
    })

    expect(config.scheduleRunnerAdmissionStatusUrl).toBe(
      'http://jangar.jangar.svc.cluster.local/api/control-plane/status?view=schedule-runner',
    )
  })
})
