import { describe, expect, it } from 'vitest'

import type {
  SourceRolloutTruthExchange,
  StageClearancePacket,
  TorghutConsumerEvidenceStatus,
} from '~/server/control-plane-status-types'
import {
  buildProjectionForeclosureNotary,
  PROJECTION_FORECLOSURE_NOTARY_DESIGN_ARTIFACT,
  type ProjectionForeclosureAgentRunProjection,
  type ProjectionForeclosureMarketContextProjection,
} from '~/server/control-plane-projection-foreclosure-notary'

const now = new Date('2026-05-13T12:00:00.000Z')

const sourceRolloutTruthExchange = (
  overrides: Partial<SourceRolloutTruthExchange> = {},
): SourceRolloutTruthExchange => ({
  mode: 'shadow',
  design_artifact:
    'docs/agents/designs/148-jangar-source-rollout-truth-exchange-and-proof-floor-settlement-2026-05-07.md',
  exchange_id: 'source-rollout-truth:converged',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-13T12:02:00.000Z',
  namespace: 'agents',
  source_head_sha: 'source-sha',
  gitops_revision: 'gitops-sha',
  desired_images: [],
  live_images: [],
  controller_heartbeats: [],
  route_statuses: [],
  database_projection_ref: 'database:healthy',
  watch_cache_ref: 'watch:healthy',
  torghut_proof_floor: {
    proof_floor_ref: 'torghut-proof-floor:closed',
    state: 'closed',
    capital_state: 'zero_notional',
    fresh_until: '2026-05-13T12:02:00.000Z',
    blockers: [],
    evidence_refs: [],
  },
  receipts: [],
  deployer_summary: {
    settlement_state: 'converged',
    freshest_blocking_reason: null,
    rollback_target: null,
    held_action_classes: [],
    receipt_refs: [],
  },
  rollback_target: null,
  ...overrides,
})

const torghutEvidence = (overrides: Partial<TorghutConsumerEvidenceStatus> = {}): TorghutConsumerEvidenceStatus => ({
  status: 'disabled',
  endpoint: 'http://torghut/consumer-evidence',
  receipt_id: null,
  generated_at: null,
  fresh_until: null,
  candidate_id: null,
  dataset_snapshot_ref: null,
  max_notional: '0',
  reason_codes: [],
  message: 'disabled',
  ...overrides,
})

const stagePacket = (overrides: Partial<StageClearancePacket> = {}): StageClearancePacket => ({
  schema_version: 'jangar.stage-clearance-packet.v1',
  packet_id: 'stage-clearance:implement:dispatch_normal',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-13T12:02:00.000Z',
  namespace: 'agents',
  swarm_name: 'jangar-control-plane',
  stage: 'implement',
  action_class: 'dispatch_normal',
  governing_requirement_refs: ['swarm-validation-contract:every-run-cites-governing-requirement'],
  source_rollout_truth_ref: 'source-rollout-truth:converged',
  controller_witness_ref: 'controller-witness:current',
  agentrun_ingestion_ref: 'agentrun-ingestion:current',
  execution_trust_ref: 'execution-trust:current',
  material_action_verdict_ref: 'material-action-verdict:dispatch_normal',
  route_stability_ref: 'route-stability:healthy',
  torghut_consumer_evidence_ref: null,
  failure_domain_leases: [],
  provider_capacity_ref: null,
  decision: 'allow',
  max_launches: 1,
  max_notional: 0,
  ttl_seconds: 120,
  reason_codes: [],
  required_repair_action: null,
  rollback_target: 'JANGAR_STAGE_CLEARANCE_ENFORCEMENT=observe',
  ...overrides,
})

const agentRunProjection = (
  overrides: Partial<ProjectionForeclosureAgentRunProjection> = {},
): ProjectionForeclosureAgentRunProjection => ({
  id: '00000000-0000-0000-0000-000000000001',
  agent_name: 'jangar-control-plane-implement',
  delivery_id: 'delivery:stale',
  status: 'Running',
  external_run_id: 'jangar-control-plane-implement-old',
  payload: {},
  created_at: '2026-05-13T02:00:00.000Z',
  updated_at: '2026-05-13T02:15:00.000Z',
  ...overrides,
})

const marketContextProjection = (
  overrides: Partial<ProjectionForeclosureMarketContextProjection> = {},
): ProjectionForeclosureMarketContextProjection => ({
  request_id: 'market-context:fundamentals:stale',
  symbol: 'SPY',
  domain: 'fundamentals',
  run_name: 'market-context-fundamentals-old',
  status: 'running',
  started_at: '2026-05-13T01:00:00.000Z',
  last_heartbeat_at: '2026-05-13T02:00:00.000Z',
  finished_at: null,
  created_at: '2026-05-13T01:00:00.000Z',
  updated_at: '2026-05-13T02:00:00.000Z',
  ...overrides,
})

const buildNotary = (overrides: Partial<Parameters<typeof buildProjectionForeclosureNotary>[0]> = {}) =>
  buildProjectionForeclosureNotary({
    now,
    namespace: 'agents',
    sourceHeadSha: 'source-sha',
    gitopsRevision: 'gitops-sha',
    sourceRolloutTruthExchange: sourceRolloutTruthExchange(),
    stageClearancePackets: [stagePacket()],
    torghutConsumerEvidence: torghutEvidence(),
    agentRunProjections: [],
    marketContextProjections: [],
    collectionErrors: [],
    ...overrides,
  })

describe('buildProjectionForeclosureNotary', () => {
  it('stale AgentRun rows stay visible but lose live authority', () => {
    const notary = buildNotary({
      agentRunProjections: [agentRunProjection()],
    })
    const claim = notary.claims.find((entry) => entry.claim_class === 'agentrun_execution')

    expect(notary.governing_design_refs).toContain(PROJECTION_FORECLOSURE_NOTARY_DESIGN_ARTIFACT)
    expect(notary.decision).toBe('observe_only')
    expect(claim).toMatchObject({
      authority_state: 'stale_foreclosed',
      live_authority_ref: 'agents-service-agentrun:jangar-control-plane-implement-old',
      projection_ref: 'agent_runs:00000000-0000-0000-0000-000000000001',
      reason_codes: ['agents_service_agentrun_projection_not_renewed'],
    })
    expect(notary.foreclosure_receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          claim_id: claim?.claim_id,
          authority_state: 'stale_foreclosed',
        }),
      ]),
    )
  })

  it('keeps a live AgentRun inside its requested timeout authoritative', () => {
    const notary = buildNotary({
      agentRunProjections: [
        agentRunProjection({
          external_run_id: 'jangar-control-plane-implement-live',
          payload: { timeoutSeconds: 86_400 },
        }),
      ],
    })
    const claim = notary.claims.find((entry) => entry.claim_class === 'agentrun_execution')

    expect(notary.decision).toBe('allow')
    expect(claim).toMatchObject({
      authority_state: 'authoritative',
      live_authority_ref: 'agents-service-agentrun:jangar-control-plane-implement-live',
      reason_codes: ['agents_service_agentrun_projection_current'],
    })
  })

  it('forecloses stale market-context domains independently', () => {
    const notary = buildNotary({
      marketContextProjections: [
        marketContextProjection(),
        marketContextProjection({
          request_id: 'market-context:news:fresh',
          domain: 'news',
          last_heartbeat_at: '2026-05-13T11:30:00.000Z',
          updated_at: '2026-05-13T11:30:00.000Z',
        }),
      ],
    })
    const fundamentals = notary.claims.find((entry) => entry.claim_class === 'market_context_fundamentals')
    const news = notary.claims.find((entry) => entry.claim_class === 'market_context_news')

    expect(notary.decision).toBe('observe_only')
    expect(fundamentals).toMatchObject({
      authority_state: 'stale_foreclosed',
      reason_codes: expect.arrayContaining([
        'market_context_fundamentals_projection_not_renewed',
        'market_context_completed_receipt_required',
      ]),
    })
    expect(news).toMatchObject({
      authority_state: 'grace',
      reason_codes: ['market_context_news_projection_inside_grace_budget'],
    })
  })

  it('keeps Torghut capital-adjacent custody repair-only when route receipts are missing', () => {
    const notary = buildNotary({
      torghutConsumerEvidence: torghutEvidence({
        status: 'current',
        receipt_id: 'torghut-route-proven-profit:clock-custody',
        generated_at: now.toISOString(),
        fresh_until: '2026-05-13T12:02:00.000Z',
        decision: 'repair_only',
        evidence_clock_arbiter_id: 'evidence-clock-arbiter:clock-custody',
        evidence_clock_state: 'current',
        evidence_clock_custody_status: 'missing',
        evidence_clock_custody_ref: null,
        route_warrant_id: 'route-warrant:repair-only',
        max_notional: '0',
        reason_codes: ['evidence_clock_custody_receipt_missing'],
        message: 'missing stage-custody receipt',
      }),
    })
    const claim = notary.claims.find((entry) => entry.claim_class === 'torghut_route_custody')

    expect(notary.decision).toBe('repair_only')
    expect(notary.stage_custody_verdict).toMatchObject({
      decision: 'repair_only',
      evidence_clock_custody_status: 'missing',
      max_notional: '0',
    })
    expect(claim).toMatchObject({
      authority_state: 'missing_receipt',
      reason_codes: expect.arrayContaining([
        'evidence_clock_custody_missing',
        'evidence_clock_custody_receipt_missing',
      ]),
    })
    expect(notary.missing_receipts.map((receipt) => receipt.required_receipt_schema)).toEqual(
      expect.arrayContaining([
        'torghut.execution-tca-refresh-receipt.v1',
        'torghut.market-context-freshness-receipt.v1',
      ]),
    )
  })
})
