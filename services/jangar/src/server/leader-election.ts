import {
  ensureLeaderElectionRuntime,
  getLeaderElectionStatus as getAgentsLeaderElectionStatus,
  isLeaderElectionRequired,
  requireLeaderForMutationHttp as requireAgentsLeaderForMutationHttp,
  stopLeaderElectionRuntime as stopAgentsLeaderElectionRuntime,
} from '@proompteng/agents/server/leader-election'

import type {
  LeaderElectionCallbacks,
  LeaderElectionConfig,
  LeaderElectionStatus,
} from '@proompteng/agents/server/leader-election'

const NOT_LEADER_RETRY_AFTER_SECONDS = 5

const globalState = globalThis as typeof globalThis & {
  __jangarLeaderElection?: {
    status?: LeaderElectionStatus
  }
}

const getLegacyLeaderElectionStatus = () => globalState.__jangarLeaderElection?.status

const buildNotLeaderResponse = () => {
  const body = JSON.stringify({
    ok: false,
    error: 'Not leader; retry on the elected controller replica.',
  })
  return new Response(body, {
    status: 503,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body).toString(),
      'retry-after': String(NOT_LEADER_RETRY_AFTER_SECONDS),
    },
  })
}

export { ensureLeaderElectionRuntime, isLeaderElectionRequired }

export const getLeaderElectionStatus = (): LeaderElectionStatus => {
  const legacyStatus = getLegacyLeaderElectionStatus()
  return legacyStatus ? { ...legacyStatus } : getAgentsLeaderElectionStatus()
}

export const isLeaderForControllers = () => {
  const status = getLeaderElectionStatus()
  if (!status.enabled || !status.required) return true
  return status.isLeader
}

export const requireLeaderForMutationHttp = (): Response | null => {
  const legacyStatus = getLegacyLeaderElectionStatus()
  if (!legacyStatus) return requireAgentsLeaderForMutationHttp()
  if (!legacyStatus.enabled || !legacyStatus.required || legacyStatus.isLeader) return null
  return buildNotLeaderResponse()
}

export const stopLeaderElectionRuntime = () => {
  stopAgentsLeaderElectionRuntime()
  Reflect.deleteProperty(globalState, '__jangarLeaderElection')
}

export type { LeaderElectionCallbacks, LeaderElectionConfig, LeaderElectionStatus }
