import { describe, expect, it } from 'vitest'

import type {
  ControlPlaneControllerWitnessQuorum,
  DatabaseStatus,
  ExecutionTrustStatus,
  SourceRolloutTruthExchange,
} from '~/server/control-plane-status-types'
import { buildDependencyVerdictExchange } from '~/server/control-plane-dependency-verdict'
import type { ControlPlaneRolloutHealth, ControlPlaneWatchReliability } from '~/server/control-plane-status-types'
import type { TorghutConsumerEvidenceStatus } from '~/server/control-plane-torghut-consumer-evidence'

const now = new Date('2026-05-13T00:20:00.000Z')

const database = (): DatabaseStatus =>
  ({ status: 'healthy', migration_consistency: { status: 'healthy' } }) as unknown as DatabaseStatus

const watchReliability = (): ControlPlaneWatchReliability =>
  ({ status: 'healthy', total_errors: 0 }) as unknown as ControlPlaneWatchReliability

const rolloutHealth = (): ControlPlaneRolloutHealth =>
  ({ status: 'healthy', deployments: [] }) as unknown as ControlPlaneRolloutHealth

const controllerWitness = (): ControlPlaneControllerWitnessQuorum =>
  ({
    quorum_id: 'controller-witness:current',
    expires_at: '2026-05-13T00:25:00.000Z',
    decision: 'allow',
  }) as unknown as ControlPlaneControllerWitnessQuorum

const executionTrust = (overrides: Partial<ExecutionTrustStatus> = {}): ExecutionTrustStatus =>
  ({
    status: 'degraded',
    reason: 'implement stage stale',
    blocking_windows: [{ type: 'stages', scope: 'agents/jangar-control-plane', name: 'implement' }],
    ...overrides,
  }) as unknown as ExecutionTrustStatus

const sourceRolloutTruth = (): SourceRolloutTruthExchange =>
  ({
    exchange_id: 'source-rollout-truth:current',
    fresh_until: '2026-05-13T00:25:00.000Z',
    receipts: [],
  }) as unknown as SourceRolloutTruthExchange

const torghutEvidence = (overrides: Partial<TorghutConsumerEvidenceStatus> = {}): TorghutConsumerEvidenceStatus =>
  ({
    status: 'current',
    receipt_id: 'torghut-route-proven-profit:repair',
    fresh_until: '2026-05-13T00:25:00.000Z',
    max_notional: '0',
    decision: 'repair',
    route_warrant_id: 'torghut-route-warrant:repair',
    route_warrant_state: 'repair_only',
    route_warrant_fresh_until: '2026-05-13T00:25:00.000Z',
    route_warrant_repair_packet_ids: ['route-warrant-repair:ingestion'],
    route_warrant_repair_target_value_gates: ['zero_notional_or_stale_evidence_rate'],
    route_warrant_blocking_dependency_names: ['ingestion', 'active_tca'],
    route_warrant_blocking_reason_codes: ['quant_ingestion_stale', 'execution_tca_stale'],
    route_warrant_capital_gate_safety: 'hold',
    accepted_routeable_candidate_count: 0,
    reason_codes: ['quant_ingestion_stale', 'execution_tca_stale'],
    ...overrides,
  }) as unknown as TorghutConsumerEvidenceStatus

const build = (overrides: Partial<Parameters<typeof buildDependencyVerdictExchange>[0]> = {}) =>
  buildDependencyVerdictExchange({
    now,
    namespace: 'agents',
    database: database(),
    watchReliability: watchReliability(),
    rolloutHealth: rolloutHealth(),
    controllerWitness: controllerWitness(),
    executionTrust: executionTrust(),
    sourceRolloutTruthExchange: sourceRolloutTruth(),
    torghutConsumerEvidence: torghutEvidence(),
    ...overrides,
  })

const verdict = (exchange: ReturnType<typeof build>, actionClass: string) => {
  const found = exchange.verdicts.find((entry) => entry.action_class === actionClass)
  expect(found).toBeTruthy()
  return found!
}

describe('control-plane dependency verdict', () => {
  it('allows read-only service while repair-only Torghut warrants hold normal action classes', () => {
    const exchange = build()

    expect(exchange).toMatchObject({
      mode: 'observe',
      design_artifact:
        'docs/agents/designs/186-jangar-route-warrant-dispatch-custody-and-dependency-verdicts-2026-05-13.md',
      torghut_route_warrant_ref: 'torghut-route-warrant:repair',
      repair_only_action_classes: ['repair'],
      held_action_classes: expect.arrayContaining(['implement', 'paper', 'deploy_widen', 'merge_ready']),
      blocked_action_classes: ['live'],
    })
    expect(verdict(exchange, 'serve_readonly')).toMatchObject({
      decision: 'allow',
      allowed_scope: 'read_only',
      max_notional: 0,
    })
    expect(verdict(exchange, 'repair')).toMatchObject({
      decision: 'repair_only',
      allowed_scope: 'zero_notional_repair',
      max_dispatches: 1,
      max_notional: 0,
      torghut_route_warrant_ref: 'torghut-route-warrant:repair',
      torghut_repair_packet_refs: ['route-warrant-repair:ingestion'],
      blocking_dependency_names: expect.arrayContaining(['ingestion', 'active_tca']),
    })
    expect(verdict(exchange, 'implement')).toMatchObject({
      decision: 'hold',
      blocking_reason_codes: expect.arrayContaining(['routeable_candidate_count_zero', 'quant_ingestion_stale']),
    })
    expect(verdict(exchange, 'live')).toMatchObject({
      decision: 'block',
      blocking_reason_codes: expect.arrayContaining(['capital_gate_safety_not_pass', 'max_notional_not_positive']),
    })
  })

  it('holds repair and observe when the Torghut route warrant is missing', () => {
    const exchange = build({
      torghutConsumerEvidence: torghutEvidence({
        route_warrant_id: null,
        route_warrant_state: null,
        route_warrant_repair_packet_ids: [],
        route_warrant_repair_target_value_gates: [],
      }),
    })

    expect(exchange.torghut_route_warrant_ref).toBeNull()
    expect(verdict(exchange, 'observe')).toMatchObject({
      decision: 'hold',
      blocking_reason_codes: expect.arrayContaining(['route_warrant_not_current', 'route_warrant_missing']),
    })
    expect(verdict(exchange, 'repair')).toMatchObject({
      decision: 'hold',
      max_dispatches: 0,
      max_notional: 0,
      blocking_reason_codes: expect.arrayContaining([
        'route_warrant_not_current',
        'route_warrant_missing',
        'route_warrant_repair_packet_unscoped',
      ]),
    })
  })

  it('allows live only when the warrant is accepted, routeable, capital-safe, and notional-positive', () => {
    const exchange = build({
      executionTrust: executionTrust({ status: 'healthy', reason: 'execution trust healthy', blocking_windows: [] }),
      torghutConsumerEvidence: torghutEvidence({
        max_notional: '250',
        decision: 'allow',
        route_warrant_state: 'live_accepted',
        route_warrant_blocking_dependency_names: [],
        route_warrant_blocking_reason_codes: [],
        route_warrant_capital_gate_safety: 'pass',
        accepted_routeable_candidate_count: 2,
        reason_codes: [],
      }),
    })

    expect(verdict(exchange, 'live')).toMatchObject({
      decision: 'allow',
      allowed_scope: 'live_support',
      max_notional: 250,
    })
  })
})
