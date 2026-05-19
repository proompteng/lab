import { afterEach, describe, expect, it } from 'vitest'

import { __test__ } from './summary'

const originalSwarmPrimitiveEnabled = process.env.AGENTS_SWARM_PRIMITIVE_ENABLED

afterEach(() => {
  if (originalSwarmPrimitiveEnabled === undefined) {
    delete process.env.AGENTS_SWARM_PRIMITIVE_ENABLED
  } else {
    process.env.AGENTS_SWARM_PRIMITIVE_ENABLED = originalSwarmPrimitiveEnabled
  }
})

describe('control-plane summary kinds', () => {
  it('omits Swarm unless the domain primitive is explicitly enabled', () => {
    delete process.env.AGENTS_SWARM_PRIMITIVE_ENABLED
    expect(__test__.resolveSummaryKinds()).not.toContain('Swarm')

    process.env.AGENTS_SWARM_PRIMITIVE_ENABLED = 'true'
    expect(__test__.resolveSummaryKinds()).toContain('Swarm')
  })
})
