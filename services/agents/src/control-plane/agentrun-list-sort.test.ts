import { describe, expect, it } from 'vitest'

import type { PrimitiveResourceSummary } from './api-client'
import {
  nextAgentRunSortSearch,
  parseAgentRunListSearch,
  sortAgentRunResources,
  type AgentRunListSearchState,
} from './agentrun-list-sort'

const run = ({
  name,
  namespace = 'agents',
  createdAt,
  phase,
  agent,
  implementationSpec,
  inlineProvider,
}: {
  name: string
  namespace?: string
  createdAt?: string
  phase?: string
  agent?: string
  implementationSpec?: string
  inlineProvider?: string
}): PrimitiveResourceSummary => ({
  apiVersion: 'agents.proompteng.ai/v1alpha1',
  kind: 'AgentRun',
  metadata: {
    name,
    namespace,
    ...(createdAt ? { creationTimestamp: createdAt } : {}),
  },
  spec: {
    ...(agent ? { agentRef: { name: agent } } : {}),
    ...(implementationSpec
      ? { implementationSpecRef: { name: implementationSpec } }
      : inlineProvider
        ? { implementation: { inline: { source: { provider: inlineProvider } } } }
        : {}),
  },
  status: {
    ...(phase ? { phase } : {}),
  },
})

describe('AgentRun list query sort state', () => {
  it('parses valid query sort state and query-backed filters', () => {
    expect(
      parseAgentRunListSearch({
        sort: 'agent',
        direction: 'asc',
        phase: 'Running',
        runtime: 'job',
        namespace: 'agents',
        limit: '25',
        search: 'worker',
      }),
    ).toEqual({
      sort: 'agent',
      direction: 'asc',
      namespace: 'agents',
      phase: 'Running',
      status: undefined,
      runtime: 'job',
      labelSelector: undefined,
      label_selector: undefined,
      limit: 25,
      page: undefined,
      search: 'worker',
      q: undefined,
    })
  })

  it('falls back to newest-first sort state for invalid query params', () => {
    expect(parseAgentRunListSearch({ sort: 'prompt', direction: 'sideways', limit: '-4' })).toMatchObject({
      sort: 'createdAt',
      direction: 'desc',
      limit: undefined,
    })
  })

  it('normalizes user-facing sort key aliases at the route boundary', () => {
    expect(parseAgentRunListSearch({ sort: 'status', direction: 'asc' })).toMatchObject({
      sort: 'phase',
      direction: 'asc',
    })
    expect(parseAgentRunListSearch({ sort: 'age', direction: 'desc' })).toMatchObject({
      sort: 'createdAt',
      direction: 'desc',
    })
    expect(parseAgentRunListSearch({ sort: 'implementationSpec', direction: 'asc' })).toMatchObject({
      sort: 'source',
      direction: 'asc',
    })
  })

  it('serializes the next sort state without dropping existing filters', () => {
    const current: AgentRunListSearchState = {
      sort: 'createdAt',
      direction: 'desc',
      status: 'Running,Failed',
      phase: 'Failed',
      runtime: 'job',
      page: 3,
      search: 'controller',
    }

    expect(nextAgentRunSortSearch(current, 'name')).toEqual({
      sort: 'name',
      direction: 'asc',
      status: 'Running,Failed',
      phase: 'Failed',
      runtime: 'job',
      page: 3,
      search: 'controller',
    })
  })

  it('toggles direction when sorting the active column again', () => {
    expect(nextAgentRunSortSearch({ sort: 'name', direction: 'asc' }, 'name')).toMatchObject({
      sort: 'name',
      direction: 'desc',
    })
  })
})

describe('AgentRun resource sorting', () => {
  const runs = [
    run({
      name: 'beta',
      namespace: 'agents',
      createdAt: '2026-05-26T10:00:00Z',
      phase: 'Failed',
      agent: 'writer',
      implementationSpec: 'docs-spec',
    }),
    run({
      name: 'alpha',
      namespace: 'agents',
      createdAt: '2026-05-26T12:00:00Z',
      phase: 'Running',
      agent: 'builder',
      inlineProvider: 'github',
    }),
    run({
      name: 'gamma',
      namespace: 'ops',
      phase: 'Pending',
    }),
  ]

  it('defaults to newest AgentRuns first with missing timestamps last', () => {
    expect(sortAgentRunResources(runs).map((item) => item.metadata.name)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('sorts by name in ascending and descending order', () => {
    expect(sortAgentRunResources(runs, 'name', 'asc').map((item) => item.metadata.name)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ])
    expect(sortAgentRunResources(runs, 'name', 'desc').map((item) => item.metadata.name)).toEqual([
      'gamma',
      'beta',
      'alpha',
    ])
  })

  it('sorts by phase, agent, source, namespace, and creation timestamp deterministically', () => {
    expect(sortAgentRunResources(runs, 'phase', 'asc').map((item) => item.metadata.name)).toEqual([
      'beta',
      'gamma',
      'alpha',
    ])
    expect(sortAgentRunResources(runs, 'agent', 'asc').map((item) => item.metadata.name)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ])
    expect(sortAgentRunResources(runs, 'source', 'asc').map((item) => item.metadata.name)).toEqual([
      'beta',
      'alpha',
      'gamma',
    ])
    expect(sortAgentRunResources(runs, 'namespace', 'desc').map((item) => item.metadata.name)).toEqual([
      'gamma',
      'alpha',
      'beta',
    ])
    expect(sortAgentRunResources(runs, 'createdAt', 'asc').map((item) => item.metadata.name)).toEqual([
      'beta',
      'alpha',
      'gamma',
    ])
  })

  it('uses newest timestamp, namespace, and name as stable tie-breaks', () => {
    const tied = [
      run({ name: 'zeta', namespace: 'agents', createdAt: '2026-05-26T09:00:00Z', phase: 'Running' }),
      run({ name: 'alpha', namespace: 'agents', createdAt: '2026-05-26T09:00:00Z', phase: 'Running' }),
      run({ name: 'middle', namespace: 'ops', createdAt: '2026-05-26T11:00:00Z', phase: 'Running' }),
    ]

    expect(
      sortAgentRunResources(tied, 'phase', 'asc').map((item) => `${item.metadata.namespace}/${item.metadata.name}`),
    ).toEqual(['ops/middle', 'agents/alpha', 'agents/zeta'])
  })
})
