import { makeRequirementObjective as makeRequirementObjectiveWithLimit } from '@proompteng/agent-contracts/swarm-analysis'

import { SWARM_REQUIREMENT_SCOPE_FIELD_LIMIT } from '~/server/supporting-primitives-swarm-config'

export * from '@proompteng/agent-contracts/swarm-analysis'

export const makeRequirementObjective = (description: string, payload: string) =>
  makeRequirementObjectiveWithLimit(description, payload, { maxBytes: SWARM_REQUIREMENT_SCOPE_FIELD_LIMIT })
