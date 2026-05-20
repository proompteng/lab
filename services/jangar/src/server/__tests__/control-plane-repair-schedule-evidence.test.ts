import { describe, expect, it } from 'vitest'

import { resolveRepairScheduleEvidenceNamespaces } from '~/server/control-plane-repair-schedule-evidence'

describe('control-plane repair schedule evidence', () => {
  it('uses a Jangar domain-specific namespace setting for repair schedule collection', () => {
    expect(
      resolveRepairScheduleEvidenceNamespaces('agents', {
        JANGAR_REPAIR_SCHEDULE_EVIDENCE_NAMESPACES: 'agents,agents-ci,agents',
        JANGAR_WORKFLOW_RELIABILITY_NAMESPACES: 'legacy',
      }),
    ).toEqual(['agents', 'agents-ci'])
  })

  it('keeps legacy workflow namespace env as a compatibility fallback only', () => {
    expect(
      resolveRepairScheduleEvidenceNamespaces('agents', {
        JANGAR_WORKFLOW_RELIABILITY_NAMESPACES: 'agents,agents-legacy',
      }),
    ).toEqual(['agents', 'agents-legacy'])
  })

  it('falls back to the requested namespace plus agents when the namespace setting is invalid', () => {
    expect(
      resolveRepairScheduleEvidenceNamespaces('jangar', {
        JANGAR_REPAIR_SCHEDULE_EVIDENCE_NAMESPACES: 'agents ci',
      }),
    ).toEqual(['jangar', 'agents'])
  })
})
