import { MATERIAL_REENTRY_DISPATCH_ANNOTATION } from '@proompteng/agent-contracts/swarm-material-reentry'
import { SWARM_REQUIREMENT_LABEL_ID } from '@proompteng/agent-contracts/swarm-contracts'

import { asString, readNested } from '~/server/primitives-http'
import {
  ACTIVE_PHASES,
  isIdempotencyDuplicateRun,
  TERMINAL_FAILURE_PHASES,
  TERMINAL_SUCCESS_PHASES,
} from '~/server/supporting-primitives-swarm-analysis'

export type RequirementRunState = {
  any: boolean
  active: boolean
  success: boolean
  failed: number
}

export const collectMaterialReentryDedupeKeys = (signals: Record<string, unknown>[]) =>
  new Set(
    signals
      .map((signal) => asString(readNested(signal, ['metadata', 'annotations', MATERIAL_REENTRY_DISPATCH_ANNOTATION])))
      .filter((dedupeKey): dedupeKey is string => Boolean(dedupeKey)),
  )

export const collectRequirementRunStates = (runs: Record<string, unknown>[]) => {
  const requirementRunStates = new Map<string, RequirementRunState>()
  let activeRequirementRuns = 0

  for (const run of runs) {
    const requirementId = asString(readNested(run, ['metadata', 'labels', SWARM_REQUIREMENT_LABEL_ID]))
    if (!requirementId || isIdempotencyDuplicateRun(run)) continue
    const phase = (asString(readNested(run, ['status', 'phase'])) ?? '').toLowerCase()
    const current = requirementRunStates.get(requirementId) ?? { any: false, active: false, success: false, failed: 0 }
    current.any = true
    if (TERMINAL_SUCCESS_PHASES.has(phase)) current.success = true
    if (!phase || ACTIVE_PHASES.has(phase)) {
      current.active = true
      activeRequirementRuns += 1
    }
    if (TERMINAL_FAILURE_PHASES.has(phase)) current.failed += 1
    requirementRunStates.set(requirementId, current)
  }

  return { activeRequirementRuns, requirementRunStates }
}

export const describeRequirementBridgeActivity = (input: {
  active: number
  dispatched: number
  pending: number
  throttled: number
}) => {
  if (input.throttled > 0) {
    return {
      reason: 'Throttled',
      message: `${input.pending} requirement signal(s) pending; ${input.active} active; ${input.throttled} throttled by active requirement limit`,
    }
  }

  if (input.pending > 0) {
    return {
      reason: 'Processing',
      message: `${input.pending} requirement signal(s) pending; ${input.dispatched} dispatched`,
    }
  }

  return { reason: 'Idle', message: 'no requirement signals pending' }
}
