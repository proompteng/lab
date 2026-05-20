import {
  SWARM_NAME_LABEL,
  SWARM_STAGE_LABEL,
  SWARM_STAGE_NAMES,
  type SwarmStageName,
} from '@proompteng/agent-contracts/swarm-contracts'

import { asString, readNested } from '~/server/primitives-http'

type StageName = SwarmStageName

export const resolveSwarmScheduleStage = (schedule: Record<string, unknown>): StageName | null => {
  if (!asString(readNested(schedule, ['metadata', 'labels', SWARM_NAME_LABEL]))) return null
  const stage = asString(readNested(schedule, ['metadata', 'labels', SWARM_STAGE_LABEL]))
    ?.trim()
    .toLowerCase()
  if (!stage) return null
  return SWARM_STAGE_NAMES.find((candidate) => candidate === stage) ?? null
}
