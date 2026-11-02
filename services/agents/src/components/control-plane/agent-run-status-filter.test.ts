import { describe, expect, it } from 'vitest'

import {
  filterAgentRunsByStatuses,
  parseAgentRunStatusSearch,
  serializeAgentRunStatusSearch,
  type AgentRunStatus,
} from './agent-run-status-filter'
import type { PrimitiveResourceSummary } from '../../control-plane/api-client'

const run = (name: string, phase: string | null): PrimitiveResourceSummary => ({
  apiVersion: 'agents.proompteng.ai/v1alpha1',
  kind: 'AgentRun',
  metadata: { name, namespace: 'agents' },
  spec: {},
  status: phase ? { phase } : {},
})

describe('AgentRun status filter helpers', () => {
  it('parses URL status params into known statuses in display order', () => {
    expect(parseAgentRunStatusSearch('Failed,Running,unknown,Succeeded,Failed')).toEqual([
      'Running',
      'Succeeded',
      'Failed',
    ])
    expect(parseAgentRunStatusSearch(['Cancelled', 'Pending,Running'])).toEqual(['Pending', 'Running', 'Cancelled'])
  })

  it('serializes statuses for a shareable URL search param', () => {
    const statuses: AgentRunStatus[] = ['Failed', 'Running', 'Running']

    expect(serializeAgentRunStatusSearch(statuses)).toBe('Running,Failed')
    expect(serializeAgentRunStatusSearch([])).toBeUndefined()
  })

  it('filters AgentRun rows by multiple selected phases', () => {
    const rows = [run('waiting', 'Pending'), run('active', 'Running'), run('done', 'Succeeded'), run('missing', null)]

    expect(filterAgentRunsByStatuses(rows, ['Pending', 'Succeeded']).map((item) => item.metadata.name)).toEqual([
      'waiting',
      'done',
    ])
    expect(filterAgentRunsByStatuses(rows, [])).toHaveLength(rows.length)
  })
})
