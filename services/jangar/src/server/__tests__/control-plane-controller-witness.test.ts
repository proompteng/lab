import { describe, expect, it } from 'vitest'

import {
  buildControllerWitnessQuorum,
  CONTROLLER_WITNESS_DESIGN_ARTIFACT,
} from '~/server/control-plane-controller-witness'
import type {
  AgentRunIngestionStatus,
  ControlPlaneRolloutHealth,
  ControlPlaneWatchReliability,
  ControllerStatus,
} from '~/server/control-plane-status-types'

const now = new Date('2026-05-06T12:30:00.000Z')

const controller = (overrides: Partial<ControllerStatus> = {}): ControllerStatus => ({
  name: 'agents-controller',
  enabled: true,
  started: true,
  scope_namespaces: ['agents'],
  crds_ready: true,
  missing_crds: [],
  last_checked_at: now.toISOString(),
  status: 'healthy',
  message: '',
  authority: {
    mode: 'local',
    namespace: 'agents',
    source_deployment: '',
    source_pod: '',
    observed_at: now.toISOString(),
    fresh: true,
    message: 'using local controller state',
  },
  ...overrides,
})

const externalController = (mode: 'heartbeat' | 'rollout') =>
  controller({
    authority: {
      mode,
      namespace: 'agents',
      source_deployment: 'agents-controllers',
      source_pod: mode === 'heartbeat' ? 'agents-controllers-0' : '',
      observed_at: now.toISOString(),
      fresh: true,
      message: `controller ${mode} healthy`,
    },
  })

const disabledServingController = () =>
  controller({
    enabled: false,
    started: false,
    status: 'disabled',
  })

const rollout = (available = true): ControlPlaneRolloutHealth => ({
  status: available ? 'healthy' : 'degraded',
  observed_deployments: available ? 1 : 0,
  degraded_deployments: available ? 0 : 1,
  deployments: available
    ? [
        {
          name: 'agents-controllers',
          namespace: 'agents',
          status: 'healthy',
          desired_replicas: 2,
          ready_replicas: 2,
          available_replicas: 2,
          updated_replicas: 2,
          unavailable_replicas: 0,
          message: 'deployment rollout healthy',
        },
      ]
    : [],
  message: available ? '1 configured deployment(s) healthy' : 'deployment agents-controllers missing',
})

const watch = (status: ControlPlaneWatchReliability['status'] = 'healthy'): ControlPlaneWatchReliability => ({
  status,
  window_minutes: 15,
  observed_streams: status === 'unknown' ? 0 : 1,
  total_events: status === 'unknown' ? 0 : 42,
  total_errors: status === 'degraded' ? 1 : 0,
  total_restarts: status === 'degraded' ? 1 : 0,
  streams:
    status === 'unknown'
      ? []
      : [
          {
            resource: 'agentruns',
            namespace: 'agents',
            events: 42,
            errors: status === 'degraded' ? 1 : 0,
            restarts: status === 'degraded' ? 1 : 0,
            last_seen_at: now.toISOString(),
          },
        ],
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

const unknownIngestion = () =>
  ingestion({
    status: 'unknown',
    message: 'agents controller not started',
    last_watch_event_at: null,
    last_resync_at: null,
  })

const build = (
  input: Partial<{
    servingController: ControllerStatus
    effectiveController: ControllerStatus
    rolloutHealth: ControlPlaneRolloutHealth
    watchReliability: ControlPlaneWatchReliability
    agentRunIngestion: AgentRunIngestionStatus
  }> = {},
) =>
  buildControllerWitnessQuorum({
    now,
    namespace: 'agents',
    servingController: input.servingController ?? controller(),
    effectiveController: input.effectiveController ?? input.servingController ?? controller(),
    rolloutHealth: input.rolloutHealth ?? rollout(),
    watchReliability: input.watchReliability ?? watch(),
    agentRunIngestion: input.agentRunIngestion ?? ingestion(),
  })

describe('controller witness quorum', () => {
  it('identifies the active design artifact and serving-process self-report', () => {
    const result = build({ rolloutHealth: rollout(false), watchReliability: watch('unknown') })

    expect(result.design_artifact).toBe(CONTROLLER_WITNESS_DESIGN_ARTIFACT)
    expect(result).toMatchObject({
      decision: 'allow',
      controller_self_report_current: true,
    })
    expect(result.witnesses).toEqual(
      expect.arrayContaining([expect.objectContaining({ controller_surface: 'serving_process', decision: 'allow' })]),
    )
  })

  it.each([
    {
      name: 'controller-process heartbeat current',
      input: {
        servingController: disabledServingController(),
        effectiveController: externalController('heartbeat'),
      },
      expected: {
        decision: 'allow_with_split',
        reason_codes: ['controller_process_heartbeat_authoritative'],
        controller_self_report_current: true,
      },
    },
    {
      name: 'deployment and watch current without ingestion self-report',
      input: {
        servingController: disabledServingController(),
        effectiveController: externalController('rollout'),
        agentRunIngestion: unknownIngestion(),
      },
      expected: {
        decision: 'repair_only',
        reason_codes: ['controller_witness_split'],
        controller_self_report_current: false,
      },
    },
    {
      name: 'deployment-only witness',
      input: {
        servingController: disabledServingController(),
        effectiveController: externalController('rollout'),
        watchReliability: watch('unknown'),
        agentRunIngestion: unknownIngestion(),
      },
      expected: {
        decision: 'hold_material',
        reason_codes: expect.arrayContaining(['watch_epoch_not_current']),
      },
    },
    {
      name: 'watch-only witness',
      input: {
        servingController: disabledServingController(),
        effectiveController: disabledServingController(),
        rolloutHealth: rollout(false),
        agentRunIngestion: unknownIngestion(),
      },
      expected: {
        decision: 'hold_material',
        reason_codes: expect.arrayContaining(['controller_deployment_unavailable']),
      },
    },
    {
      name: 'controller ingestion stalled',
      input: {
        agentRunIngestion: ingestion({
          status: 'degraded',
          message: 'untouched AgentRuns detected for 180s',
          untouched_run_count: 3,
          oldest_untouched_age_seconds: 180,
        }),
      },
      expected: {
        decision: 'hold_material',
        reason_codes: ['controller_ingestion_stalled'],
      },
    },
  ])('handles $name', ({ input, expected }) => {
    const result = build(input)

    expect(result).toMatchObject({
      deployment_available: input.rolloutHealth ? input.rolloutHealth.deployments.length > 0 : true,
      watch_epoch_current: input.watchReliability?.status === 'unknown' ? false : true,
      ...expected,
    })
  })
})
