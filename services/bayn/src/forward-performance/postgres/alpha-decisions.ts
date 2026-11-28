import { isIntradayAlphaTarget } from '../../strategy/runtime-decision'
import type { PgClient } from '@effect/sql-pg'
import { Result, Schema } from 'effect'

import { ExecutionBuildSchema } from '../../build'
import { CycleState } from '../../cycle/model'
import { legacyExecutionAuthorityToken } from '../../execution/legacy-wire'
import { IsoDateSchema, Sha256Schema, StrictNonEmptyStringSchema } from '../../schemas'
import { intradayAlphaStrategyIdentity } from '../../strategy/intraday-alpha/policy'
import type { NativeAlphaDecisionEvidence } from '../alpha-decisions'
import { CycleDecisionJsonRow, type TerminalCycleRow } from './model'
import { verifyPerformanceDecisionJson } from './projection'
import { capturedCycleScope, generationScope } from './scope'

export const AlphaDecisionJsonRow = Schema.Struct({
  ...CycleDecisionJsonRow.fields,
  account_id: StrictNonEmptyStringSchema,
  authority_generation_hash: Sha256Schema,
  qualification_run_id: Sha256Schema,
  strategy_protocol_hash: Sha256Schema,
  risk_policy_hash: Sha256Schema,
  session_date: IsoDateSchema,
  cycle_state: Schema.Enum(CycleState),
  terminal_at: Schema.NullOr(Schema.Date),
  generation_activated_at: Schema.Date,
  reconciled_at: Schema.Date,
  execution_evidence_in_scope: Schema.Boolean,
  qualification_build: Schema.NullOr(ExecutionBuildSchema),
  activation_build: Schema.NullOr(ExecutionBuildSchema),
})

export interface AlphaDecisionProjection {
  readonly alphaDecisions: readonly NativeAlphaDecisionEvidence[]
  readonly unverifiedAlphaDecisionHashes: readonly string[]
}

/** Retain diagnostic instructions without expanding the financial cycle or fill selection. */
export const alphaDecisionQuery = (
  sql: PgClient.PgClient,
  accountId: string,
  authorityGenerationHash: string | undefined,
  capturedCycles?: readonly (typeof TerminalCycleRow.Type)[],
) => sql<Record<string, unknown>>`
  WITH latest_reconciliation AS (
    SELECT reconciliation.reconciled_at
    FROM reconciliations AS reconciliation
    WHERE reconciliation.account_id = ${accountId}
      AND ${generationScope(sql, accountId, authorityGenerationHash, 'reconciliation')}
    ORDER BY reconciliation.reconciled_at DESC, reconciliation.reconciliation_id COLLATE "C" DESC
    LIMIT 1
  )
  SELECT cycle.cycle_id, decision.decision_hash, decision.document::text AS document_json,
    decision.created_at, cycle.account_id, generation.generation_hash AS authority_generation_hash,
    cycle.qualification_run_id, cycle.strategy_protocol_hash, generation.risk_policy_hash,
    cycle.execution_session_date::text AS session_date, cycle.state AS cycle_state, cycle.terminal_at,
    generation.activated_at AS generation_activated_at, latest_reconciliation.reconciled_at,
    (cycle.state = 'COMPLETED' AND cycle.terminal_at <= latest_reconciliation.reconciled_at
      AND ${capturedCycleScope(sql, accountId, authorityGenerationHash, capturedCycles)}) AS execution_evidence_in_scope,
    CASE WHEN generation.qualification_source_revision IS NOT NULL
      AND generation.qualification_image_repository IS NOT NULL AND generation.qualification_image_digest IS NOT NULL
      THEN jsonb_build_object('sourceRevision', generation.qualification_source_revision,
        'imageRepository', generation.qualification_image_repository, 'imageDigest', generation.qualification_image_digest)
      ELSE NULL END AS qualification_build,
    CASE WHEN generation.activation_source_revision IS NOT NULL
      AND generation.activation_image_repository IS NOT NULL AND generation.activation_image_digest IS NOT NULL
      THEN jsonb_build_object('sourceRevision', generation.activation_source_revision,
        'imageRepository', generation.activation_image_repository, 'imageDigest', generation.activation_image_digest)
      ELSE NULL END AS activation_build
  FROM autonomous_cycles AS cycle
  JOIN autonomous_cycle_shadow_decisions AS decision
    ON decision.cycle_id = cycle.cycle_id AND decision.decision_hash = cycle.decision_hash
  JOIN authority_generations AS generation
    ON ${authorityGenerationHash === undefined ? true : sql`generation.generation_hash = ${authorityGenerationHash}`}
    AND generation.account_id = cycle.account_id AND generation.maximum = 'PAPER'
    AND COALESCE(generation.qualification_run_id, generation.research_plan_hash) = cycle.qualification_run_id
    AND COALESCE(generation.protocol_hash, generation.strategy_protocol_hash) = cycle.strategy_protocol_hash
    AND generation.strategy_parameter_schema_version IN ('bayn.intraday-alpha-policy.v2', 'bayn.intraday-alpha-policy.v3')
  CROSS JOIN latest_reconciliation
  WHERE cycle.account_id = ${accountId}
    AND decision.schema_version IN ('bayn.paper-cycle-decision.v1', 'bayn.paper-cycle-decision.v2')
    AND decision.created_at >= generation.activated_at
    AND decision.created_at <= latest_reconciliation.reconciled_at
    AND NOT EXISTS (
      SELECT 1 FROM authority_generations AS next_generation
      WHERE next_generation.previous_generation_hash = generation.generation_hash
        AND next_generation.account_id = generation.account_id AND next_generation.maximum = 'PAPER'
        AND decision.created_at >= next_generation.activated_at
    )
  ORDER BY cycle.cycle_id COLLATE "C", decision.created_at, decision.decision_hash COLLATE "C"
`

export const verifyAlphaDecisionJson = (row: typeof AlphaDecisionJsonRow.Type): AlphaDecisionProjection => {
  const rejected = { alphaDecisions: [], unverifiedAlphaDecisionHashes: [row.decision_hash] } as const
  const verified = verifyPerformanceDecisionJson({
    cycle_id: row.cycle_id,
    decision_hash: row.decision_hash,
    document_json: row.document_json,
    created_at: row.created_at,
  })
  const document = verified.verifiedRows[0]?.document
  if (document === undefined || document.mode !== legacyExecutionAuthorityToken) return rejected
  const target = document.strategyDecision
  if (
    !isIntradayAlphaTarget(target) ||
    document.contentHash !== row.decision_hash ||
    document.bindings.cycleId !== row.cycle_id ||
    document.bindings.accountId !== row.account_id ||
    document.bindings.authorityGenerationHash !== row.authority_generation_hash ||
    document.bindings.qualificationRunId !== row.qualification_run_id ||
    document.bindings.strategyProtocolHash !== row.strategy_protocol_hash ||
    document.bindings.policyHash !== row.risk_policy_hash ||
    target.sessionDate !== row.session_date ||
    document.createdAt !== row.created_at.toISOString() ||
    row.created_at < row.generation_activated_at ||
    row.created_at > row.reconciled_at ||
    (row.execution_evidence_in_scope &&
      (row.cycle_state !== CycleState.Completed || row.terminal_at === null || row.terminal_at > row.reconciled_at))
  )
    return rejected
  const identity = intradayAlphaStrategyIdentity(target.policy)
  if (Result.isFailure(identity) || identity.success.protocolHash !== row.strategy_protocol_hash) return rejected
  return {
    unverifiedAlphaDecisionHashes: [],
    alphaDecisions: [
      {
        cycleId: row.cycle_id,
        accountId: row.account_id,
        authorityGenerationHash: row.authority_generation_hash,
        decisionDocumentHash: document.contentHash,
        decisionHash: document.bindings.strategyDecisionHash,
        decisionCreatedAt: document.createdAt,
        sessionDate: target.sessionDate,
        phase: target.phase,
        reason: target.reason,
        strategyProtocolHash: row.strategy_protocol_hash,
        strategyBehaviorHash: identity.success.strategy.behaviorHash,
        strategyParameterHash: identity.success.strategy.parameterHash,
        policySchemaVersion: target.policy.schemaVersion,
        riskPolicyHash: document.bindings.policyHash,
        qualificationBuild: row.qualification_build,
        activationBuild: row.activation_build,
        executingBuild: null,
        cycleState: row.cycle_state,
        terminalAt: row.terminal_at?.toISOString() ?? null,
        reconciledAt: row.reconciled_at.toISOString(),
        executionEvidenceInScope: row.execution_evidence_in_scope,
        dispatchable: document.dispatchable,
        selectedSymbols: target.selectedSymbols,
        targetWeights: target.targetWeights,
        signals: target.signals,
        targetPlan: {
          status: document.targetPlan.status,
          reason: document.targetPlan.reason,
          legs: document.targetPlan.intentTargets.map((leg, index) => ({
            symbol: leg.symbol,
            side: leg.side,
            quantityAtoms: leg.quantityAtoms,
            referencePriceMicros:
              document.targetPlan.targets.find((planned) => planned.symbol === leg.symbol)?.referencePriceMicros ??
              null,
            intentId: document.orderedIntentIds[index] ?? null,
          })),
        },
      },
    ],
  }
}
