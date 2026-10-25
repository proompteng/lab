import { describe, expect, it } from 'vitest'

import type { SourceRolloutTruthExchange } from '~/server/control-plane-status-types'
import {
  buildSourceServingContractVerdictExchange,
  SOURCE_SERVING_CONTRACT_VERDICT_DESIGN_ARTIFACT,
} from '~/server/control-plane-source-serving-contract-verdict'
import type { ControlPlaneRolloutHealth } from '~/server/control-plane-status-types'
import type { TorghutConsumerEvidenceStatus } from '~/server/control-plane-torghut-consumer-evidence'

const now = new Date('2026-05-13T05:00:00.000Z')

const sourceRolloutTruth = (overrides: Partial<SourceRolloutTruthExchange> = {}): SourceRolloutTruthExchange =>
  ({
    exchange_id: 'source-rollout-truth:torghut',
    fresh_until: '2026-05-13T05:01:00.000Z',
    source_head_sha: '4dfa7c70771f3f8d6f3884c52a77c41e5e851638',
    gitops_revision: '4dfa7c70771f3f8d6f3884c52a77c41e5e851638',
    desired_images: [],
    live_images: [],
    ...overrides,
  }) as unknown as SourceRolloutTruthExchange

const rolloutHealth = (overrides: Partial<ControlPlaneRolloutHealth> = {}): ControlPlaneRolloutHealth =>
  ({
    status: 'healthy',
    deployments: [],
    observed_deployments: 1,
    degraded_deployments: 0,
    ...overrides,
  }) as unknown as ControlPlaneRolloutHealth

const torghutEvidence = (overrides: Partial<TorghutConsumerEvidenceStatus> = {}): TorghutConsumerEvidenceStatus =>
  ({
    status: 'current',
    receipt_id: 'torghut-route-proven-profit:current',
    fresh_until: '2026-05-13T05:01:00.000Z',
    max_notional: '0',
    route_warrant_id: 'torghut-route-warrant:repair',
    repair_bid_settlement_ledger_id: 'repair-bid-settlement-ledger:current',
    build_commit: '4dfa7c70771f3f8d6f3884c52a77c41e5e851638',
    serving_revision: 'torghut-00340',
    observed_contracts: ['route_warrant_exchange', 'repair_bid_settlement_ledger'],
    contract_schema_mismatches: [],
    reason_codes: [],
    message: 'current',
    ...overrides,
  }) as unknown as TorghutConsumerEvidenceStatus

const build = (overrides: Partial<Parameters<typeof buildSourceServingContractVerdictExchange>[0]> = {}) =>
  buildSourceServingContractVerdictExchange({
    now,
    namespace: 'agents',
    sourceRolloutTruthExchange: sourceRolloutTruth(),
    rolloutHealth: rolloutHealth(),
    torghutConsumerEvidence: torghutEvidence(),
    evidence: {
      sourceCiRunId: '9001',
      sourceCiConclusion: 'success',
      manifestImageDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
    ...overrides,
  })

const verdict = (exchange: ReturnType<typeof build>, actionClass: string) => {
  const found = exchange.verdicts.find((entry) => entry.action_class === actionClass)
  expect(found).toBeTruthy()
  return found!
}

describe('control-plane source-serving contract verdict', () => {
  it('allows only zero-notional repair when source and contracts match but runtime digest is unknown', () => {
    const exchange = build()

    expect(exchange).toMatchObject({
      mode: 'observe',
      design_artifact: SOURCE_SERVING_CONTRACT_VERDICT_DESIGN_ARTIFACT,
      source_sha: '4dfa7c70771f3f8d6f3884c52a77c41e5e851638',
      serving_build_commit: '4dfa7c70771f3f8d6f3884c52a77c41e5e851638',
      missing_contracts: [],
      repair_only_action_classes: ['dispatch_repair'],
      held_action_classes: expect.arrayContaining(['dispatch_normal', 'deploy_widen', 'merge_ready']),
      blocked_action_classes: ['live_support'],
    })
    expect(verdict(exchange, 'dispatch_repair')).toMatchObject({
      decision: 'repair_only',
      source_serving_state: 'digest_unknown',
      max_notional: 0,
      blocking_reason_codes: ['serving_image_digest_missing'],
      torghut_repair_bid_settlement_ref: 'repair-bid-settlement-ledger:current',
    })
    expect(verdict(exchange, 'deploy_widen')).toMatchObject({
      decision: 'hold',
      blocking_reason_codes: expect.arrayContaining(['serving_image_digest_missing']),
    })
  })

  it('holds repair when the serving Torghut payload is missing required contract canaries', () => {
    const exchange = build({
      torghutConsumerEvidence: torghutEvidence({
        repair_bid_settlement_ledger_id: null,
        observed_contracts: ['route_warrant_exchange'],
      }),
    })

    expect(exchange.missing_contracts).toEqual(['repair_bid_settlement_ledger'])
    expect(verdict(exchange, 'dispatch_repair')).toMatchObject({
      decision: 'hold',
      source_serving_state: 'contract_missing',
      blocking_reason_codes: expect.arrayContaining([
        'source_serving_contract_missing:repair_bid_settlement_ledger',
        'repair_bid_settlement_ledger_missing',
      ]),
    })
    expect(verdict(exchange, 'paper_support')).toMatchObject({
      decision: 'hold',
      max_notional: 0,
    })
  })

  it('allows deploy, merge, paper, and live only when source CI, build, digest, and contracts converge', () => {
    const digest = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const exchange = build({
      torghutConsumerEvidence: torghutEvidence({
        max_notional: '250',
        serving_image_digest: digest,
      }),
      evidence: {
        sourceCiRunId: '9002',
        sourceCiConclusion: 'success',
        manifestImageDigest: digest,
      },
    })

    expect(exchange.status).toBe('allow')
    expect(exchange.allowed_action_classes).toEqual([
      'serve_readonly',
      'dispatch_repair',
      'dispatch_normal',
      'deploy_widen',
      'merge_ready',
      'paper_support',
      'live_support',
    ])
    expect(verdict(exchange, 'live_support')).toMatchObject({
      decision: 'allow',
      source_serving_state: 'converged',
      max_notional: 250,
    })
  })

  it('uses Jangar serving proof env instead of Torghut build metadata for source convergence', () => {
    const digest = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
    const exchange = build({
      torghutConsumerEvidence: torghutEvidence({
        build_commit: 'torghut-build-commit',
        image_digest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        max_notional: '250',
      }),
      evidence: {
        sourceCiRunId: '9003',
        sourceCiConclusion: 'success',
        manifestImageDigest: digest,
        servingBuildCommit: '4dfa7c70771f3f8d6f3884c52a77c41e5e851638',
        servingImageDigest: digest,
      },
    })

    expect(exchange.status).toBe('allow')
    expect(exchange.serving_build_commit).toBe('4dfa7c70771f3f8d6f3884c52a77c41e5e851638')
    expect(exchange.serving_image_digest).toBe(digest)
    expect(exchange.reason_codes).not.toContain('source_serving_build_mismatch')
    expect(exchange.reason_codes).not.toContain('manifest_serving_image_digest_mismatch')
    expect(verdict(exchange, 'live_support')).toMatchObject({
      decision: 'allow',
      source_serving_state: 'converged',
      max_notional: 250,
    })
  })
})
