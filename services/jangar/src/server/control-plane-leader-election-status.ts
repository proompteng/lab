import type { ControlPlaneStatus } from '~/server/control-plane-status-types'
import { getLeaderElectionStatus } from '~/server/leader-election'

export const buildControlPlaneLeaderElectionStatus = (): ControlPlaneStatus['leader_election'] => {
  const leaderElection = getLeaderElectionStatus()

  return {
    enabled: leaderElection.enabled,
    required: leaderElection.required,
    is_leader: leaderElection.isLeader,
    lease_name: leaderElection.leaseName,
    lease_namespace: leaderElection.leaseNamespace,
    identity: leaderElection.identity,
    last_transition_at: leaderElection.lastTransitionAt ?? '',
    last_attempt_at: leaderElection.lastAttemptAt ?? '',
    last_success_at: leaderElection.lastSuccessAt ?? '',
    last_error: leaderElection.lastError ?? '',
  }
}
