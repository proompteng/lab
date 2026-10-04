import { describe, expect, it } from 'vitest'

import {
  requireTorghutSimulationMutationHttp,
  resolveTorghutSimulationMutationGate,
} from '~/server/torghut-simulation-mutation-gate'

describe('torghut-simulation-mutation-gate', () => {
  it('allows mutations by default without a copied Agents leader election runtime', () => {
    expect(resolveTorghutSimulationMutationGate({}).enabled).toBe(true)
    expect(requireTorghutSimulationMutationHttp({})).toBeNull()
  })

  it('blocks mutations with a domain-specific maintenance switch', async () => {
    const response = requireTorghutSimulationMutationHttp({
      JANGAR_TORGHUT_SIMULATION_MUTATIONS_ENABLED: 'false',
      JANGAR_TORGHUT_SIMULATION_MUTATIONS_DISABLED_REASON: 'maintenance',
    })

    expect(response?.status).toBe(503)
    expect(response?.headers.get('retry-after')).toBe('30')
    await expect(response?.json()).resolves.toMatchObject({
      ok: false,
      reason: 'maintenance',
    })
  })
})
