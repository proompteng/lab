import { describe, expect, it } from 'vitest'

import { listPrimitiveKinds, resolvePrimitiveKind } from './control-plane-primitive-kinds'

describe('control-plane primitive kinds', () => {
  it('omits Swarm from default primitive lists while preserving direct kind resolution', () => {
    expect(listPrimitiveKinds()).not.toContain('Swarm')
    expect(listPrimitiveKinds({ includeSwarm: true })).toContain('Swarm')
    expect(resolvePrimitiveKind('Swarm')).toMatchObject({ kind: 'Swarm' })
  })

  it('resolves runtime-owned Kubernetes resources without adding them to primitive watch lists', () => {
    expect(resolvePrimitiveKind('Job')).toMatchObject({ kind: 'Job', resource: 'jobs.batch' })
    expect(resolvePrimitiveKind('Pod')).toMatchObject({ kind: 'Pod', resource: 'pods' })
    expect(resolvePrimitiveKind('Deployment')).toMatchObject({ kind: 'Deployment', resource: 'deployments' })
    expect(listPrimitiveKinds()).not.toContain('Job' as never)
    expect(listPrimitiveKinds({ includeSwarm: true })).not.toContain('Pod' as never)
  })
})
