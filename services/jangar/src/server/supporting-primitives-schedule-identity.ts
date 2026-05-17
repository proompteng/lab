import { asString, readNested } from '~/server/primitives-http'
import { STAGE_NAMES, type StageName } from '~/server/supporting-primitives-swarm-config'

const SWARM_STAGE_LABEL = 'swarm.proompteng.ai/stage'
const SWARM_NAME_LABEL = 'swarm.proompteng.ai/name'

export const resolveSwarmScheduleStage = (schedule: Record<string, unknown>): StageName | null => {
  if (!asString(readNested(schedule, ['metadata', 'labels', SWARM_NAME_LABEL]))) return null
  const stage = asString(readNested(schedule, ['metadata', 'labels', SWARM_STAGE_LABEL]))
    ?.trim()
    .toLowerCase()
  if (!stage) return null
  return STAGE_NAMES.find((candidate) => candidate === stage) ?? null
}
