import { describe, expect, it } from 'vitest'

import { listPrimitiveKinds, resolvePrimitiveKind } from './control-plane-primitive-kinds'

describe('control-plane primitive kinds', () => {
  it('omits Swarm from default primitive lists while preserving direct kind resolution', () => {
    expect(listPrimitiveKinds()).not.toContain('Swarm')
    expect(listPrimitiveKinds({ includeSwarm: true })).toContain('Swarm')
    expect(resolvePrimitiveKind('Swarm')).toMatchObject({ kind: 'Swarm' })
  })
})
