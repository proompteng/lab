import { describe, expect, it } from 'vitest'

import {
  AGENTS_CONTROLLER_WITNESS_DESIGN_ARTIFACT,
  type AgentRunIngestionStatus,
  type ControlPlaneRolloutHealth,
  type ControlPlaneWatchReliability,
  type ControllerStatus,
} from './control-plane-status'
import { buildControllerWitnessQuorum } from './controller-witness'

const now = new Date('2026-05-20T09:00:00.000Z')

const controller = (overrides: Partial<ControllerStatus> = {}): ControllerStatus => ({
  name: 'agents-controller',
  enabled: true,
  started: true,
  scope_namespaces: ['agents'],
  crds_ready: true,
  missing_crds: [],
  last_checked_at: now.toISOString(),
  status: 'healthy',
  message: 'controller healthy',
  authority: {
    mode: 'local',
    namespace: 'agents',
    source_deployment: 'agents-controllers',
    source_pod: 'agents-controllers-0',
    observed_at: now.toISOString(),
    fresh: true,
    message: 'controller healthy',
  },
  ...overrides,
})

const ingestion = (overrides: Partial<AgentRunIngestionStatus> = {}): AgentRunIngestionStatus => ({
  namespace: 'agents',
  status: 'healthy',
  message: 'AgentRun ingestion healthy',
  last_watch_event_at: now.toISOString(),
  last_resync_at: now.toISOString(),
  untouched_run_count: 0,
  oldest_untouched_age_seconds: null,
  ...overrides,
})

const watchReliability: ControlPlaneWatchReliability = {
  status: 'healthy',
  window_minutes: 15,
  observed_streams: 1,
  total_events: 8,
  total_errors: 0,
  total_restarts: 0,
  streams: [
    {
      resource: 'agentruns.agents.proompteng.ai',
      namespace: 'agents',
      events: 8,
      errors: 0,
      restarts: 0,
      last_seen_at: now.toISOString(),
    },
  ],
}

const rolloutHealth: ControlPlaneRolloutHealth = {
  status: 'healthy',
  observed_deployments: 1,
  degraded_deployments: 0,
  deployments: [
    {
      name: 'agents-controllers',
      namespace: 'agents',
      status: 'healthy',
      desired_replicas: 2,
      ready_replicas: 2,
      available_replicas: 2,
      updated_replicas: 2,
      unavailable_replicas: 0,
      message: 'agents-controllers deployment healthy',
    },
  ],
  message: 'control-plane rollout healthy',
}

describe('controller witness', () => {
  it('builds the Agents-owned controller witness quorum contract', () => {
    const witness = buildControllerWitnessQuorum({
      namespace: 'agents',
      now,
      servingController: controller(),
      effectiveController: controller(),
      rolloutHealth,
      agentRunIngestion: ingestion(),
      watchReliability,
      leaderIdentity: 'agents-controllers-0',
    })

    expect(witness).toMatchObject({
      design_artifact: AGENTS_CONTROLLER_WITNESS_DESIGN_ARTIFACT,
      namespace: 'agents',
      decision: 'allow',
      deployment_available: true,
      controller_self_report_current: true,
      rollback_target: null,
    })
    expect(witness.quorum_id).toMatch(/^controller-witness:/)
    expect(witness.witnesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ controller_surface: 'serving_process', decision: 'allow' }),
        expect.objectContaining({ controller_surface: 'kubernetes_deployment', decision: 'allow' }),
        expect.objectContaining({ controller_surface: 'watch_epoch', decision: 'allow' }),
        expect.objectContaining({ controller_surface: 'agentrun_ingestion', decision: 'allow' }),
      ]),
    )
  })

  it('holds material action when AgentRun ingestion is degraded', () => {
    const witness = buildControllerWitnessQuorum({
      namespace: 'agents',
      now,
      servingController: controller(),
      effectiveController: controller(),
      rolloutHealth,
      agentRunIngestion: ingestion({ status: 'degraded', untouched_run_count: 3 }),
      watchReliability,
    })

    expect(witness).toMatchObject({
      decision: 'hold_material',
      reason_codes: expect.arrayContaining(['controller_ingestion_stalled']),
      controller_self_report_current: true,
      rollback_target: 'hold normal dispatch and repair AgentRun ingestion before material action',
    })
  })

  it('models heartbeat-authoritative controller split without Jangar-owned types', () => {
    const baseController = controller()
    const witness = buildControllerWitnessQuorum({
      namespace: 'agents',
      now,
      servingController: controller({ started: false, status: 'unknown' }),
      effectiveController: controller({
        authority: {
          ...baseController.authority,
          mode: 'heartbeat',
          source_pod: 'agents-controllers-abc',
        },
      }),
      rolloutHealth,
      agentRunIngestion: ingestion(),
      watchReliability,
    })

    expect(witness).toMatchObject({
      decision: 'allow_with_split',
      reason_codes: expect.arrayContaining(['controller_process_heartbeat_authoritative']),
      controller_self_report_current: true,
    })
    expect(witness.witnesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ controller_surface: 'controller_process', decision: 'allow' }),
      ]),
    )
  })
})
