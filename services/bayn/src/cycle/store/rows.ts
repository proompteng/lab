import { Effect, Result, Schema } from 'effect'

import { Pipeable } from '../../pipeable'
import {
  IsoDateSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../../schemas'
import { CycleDecisionDocumentSchema } from '../../shadow-decision-contract'
import {
  AutonomousCycleSchema,
  CycleDraftSchema,
  CycleState,
  CycleTerminalReason,
  type AutonomousCycle,
} from '../model'

const StoredCycleRowSchema = Schema.Struct({
  cycle_id: Sha256Schema,
  schema_version: Schema.Literals(['bayn.autonomous-cycle.v1', 'bayn.autonomous-cycle.v2', 'bayn.autonomous-cycle.v3']),
  identity_schema_version: Schema.Literals([
    'bayn.autonomous-cycle-identity.v1',
    'bayn.autonomous-cycle-identity.v2',
    'bayn.autonomous-cycle-identity.v3',
  ]),
  strategy_name: Schema.Literals(['risk-balanced-trend', 'opening-drive-momentum', 'intraday-momentum']),
  qualification_run_id: Sha256Schema,
  strategy_protocol_hash: Sha256Schema,
  account_id: StrictNonEmptyStringSchema,
  signal_session_date: Schema.NullOr(IsoDateSchema),
  signal_calendar_version: Schema.NullOr(StrictNonEmptyStringSchema),
  execution_policy_schema_version: Schema.Literals([
    'bayn.autonomous-cycle-execution-policy.v1',
    'bayn.autonomous-cycle-execution-policy.v2',
    'bayn.autonomous-cycle-execution-policy.v3',
  ]),
  execution_policy_hash: Sha256Schema,
  strategy_execution_model_hash: Sha256Schema,
  submission_window_ms: PositiveIntegerSchema,
  submission_cutoff_before_open_ms: Schema.NullOr(PositiveIntegerSchema),
  submission_cutoff_after_open_ms: Schema.NullOr(PositiveIntegerSchema),
  warmup_after_open_ms: Schema.NullOr(PositiveIntegerSchema),
  submission_cutoff_before_close_ms: Schema.NullOr(PositiveIntegerSchema),
  window_schema_version: Schema.Literals([
    'bayn.autonomous-cycle-window.v1',
    'bayn.autonomous-cycle-window.v2',
    'bayn.autonomous-cycle-window.v3',
  ]),
  execution_calendar_schema_version: Schema.Literal('bayn.alpaca-market-calendar-observation.v1'),
  execution_calendar_source: Schema.Literal('alpaca-v2-calendar'),
  execution_calendar_hash: Sha256Schema,
  execution_session_date: IsoDateSchema,
  signal_close_at: Schema.NullOr(Schema.Date),
  publication_deadline_at: Schema.NullOr(Schema.Date),
  submission_open_at: Schema.Date,
  execution_open_at: Schema.Date,
  execution_close_at: Schema.Date,
  submission_cutoff_at: Schema.Date,
  state: Schema.Enum(CycleState),
  snapshot_id: Schema.NullOr(Sha256Schema),
  decision_hash: Schema.NullOr(Sha256Schema),
  terminal_reason: Schema.NullOr(Schema.Enum(CycleTerminalReason)),
  state_version: PositiveIntegerSchema,
  created_at: Schema.Date,
  updated_at: Schema.Date,
  terminal_at: Schema.NullOr(Schema.Date),
})

const CycleIdInputSchema = Schema.Struct({ cycleId: Sha256Schema, observedAt: UtcInstantSchema })
const CycleAuthoritySlotScopeFields = {
  qualificationRunId: Sha256Schema,
  accountId: StrictNonEmptyStringSchema,
} as const
const CycleAuthoritySlotSchema = Schema.Union([
  Schema.Struct({ ...CycleAuthoritySlotScopeFields, signalSessionDate: IsoDateSchema }),
  Schema.Struct({ ...CycleAuthoritySlotScopeFields, executionSessionDate: IsoDateSchema }),
])
const CycleRecoveryScopeSchema = Schema.Struct({
  qualificationRunId: Sha256Schema,
  accountId: StrictNonEmptyStringSchema,
})
const SnapshotInputSchema = Schema.Struct({ cycleId: Sha256Schema, observedAt: UtcInstantSchema })
const DecisionInputSchema = Schema.Struct({
  cycleId: Sha256Schema,
  document: CycleDecisionDocumentSchema,
  observedAt: UtcInstantSchema,
})
const BlockInputSchema = Schema.Struct({
  cycleId: Sha256Schema,
  reason: Schema.Enum(CycleTerminalReason),
  observedAt: UtcInstantSchema,
})
const FinishInputSchema = Schema.Struct({
  cycleId: Sha256Schema,
  state: Schema.Literals([CycleState.Completed, CycleState.NoTrade]),
  observedAt: UtcInstantSchema,
})
const MutationRowsSchema = Schema.Array(Schema.Struct({ cycle_id: Sha256Schema })).check(Schema.isMaxLength(1))
const DecisionEvidenceMatchSchema = Schema.Tuple([Schema.Struct({ matches: Schema.Boolean })])
const StoredDecisionDocumentRowsSchema = Schema.Array(
  Schema.Struct({
    document: CycleDecisionDocumentSchema,
    execution_completion_evidence_matches: Schema.Boolean,
    execution_generation_is_superseded: Schema.Boolean,
  }),
)

const decodeCycleIdDataFirst = Schema.decodeUnknownEffect(Sha256Schema, strictParseOptions)

export const decodeCycleId = Pipeable.dual(1, (input: unknown) => decodeCycleIdDataFirst(input))
const decodeCycleIdInputDataFirst = Schema.decodeUnknownEffect(CycleIdInputSchema, strictParseOptions)

export const decodeCycleIdInput = Pipeable.dual(1, (input: unknown) => decodeCycleIdInputDataFirst(input))
const decodeCycleAuthoritySlotDataFirst = Schema.decodeUnknownEffect(CycleAuthoritySlotSchema, strictParseOptions)

export const decodeCycleAuthoritySlot = Pipeable.dual(1, (input: unknown) => decodeCycleAuthoritySlotDataFirst(input))
const decodeCycleRecoveryScopeDataFirst = Schema.decodeUnknownEffect(CycleRecoveryScopeSchema, strictParseOptions)

export const decodeCycleRecoveryScope = Pipeable.dual(1, (input: unknown) => decodeCycleRecoveryScopeDataFirst(input))
const decodeSnapshotInputDataFirst = Schema.decodeUnknownEffect(SnapshotInputSchema, strictParseOptions)

export const decodeSnapshotInput = Pipeable.dual(1, (input: unknown) => decodeSnapshotInputDataFirst(input))
const decodeDecisionInputDataFirst = Schema.decodeUnknownEffect(DecisionInputSchema, strictParseOptions)

export const decodeDecisionInput = Pipeable.dual(1, (input: unknown) => decodeDecisionInputDataFirst(input))
const decodeBlockInputDataFirst = Schema.decodeUnknownEffect(BlockInputSchema, strictParseOptions)

export const decodeBlockInput = Pipeable.dual(1, (input: unknown) => decodeBlockInputDataFirst(input))
const decodeFinishInputDataFirst = Schema.decodeUnknownEffect(FinishInputSchema, strictParseOptions)

export const decodeFinishInput = Pipeable.dual(1, (input: unknown) => decodeFinishInputDataFirst(input))
const decodeCycleDraftDataFirst = Schema.decodeUnknownEffect(CycleDraftSchema, strictParseOptions)

export const decodeCycleDraft = Pipeable.dual(1, (input: unknown) => decodeCycleDraftDataFirst(input))
const decodeObservedAtDataFirst = Schema.decodeUnknownEffect(UtcInstantSchema, strictParseOptions)

export const decodeObservedAt = Pipeable.dual(1, (input: unknown) => decodeObservedAtDataFirst(input))
const decodeMutationRowsDataFirst = Schema.decodeUnknownEffect(MutationRowsSchema, strictParseOptions)

export const decodeMutationRows = Pipeable.dual(1, (input: unknown) => decodeMutationRowsDataFirst(input))
const decodeDecisionEvidenceMatchDataFirst = Schema.decodeUnknownEffect(DecisionEvidenceMatchSchema, strictParseOptions)

export const decodeDecisionEvidenceMatch = Pipeable.dual(1, (input: unknown) =>
  decodeDecisionEvidenceMatchDataFirst(input),
)
const decodeStoredDecisionDocumentRowsDataFirst = Schema.decodeUnknownEffect(
  StoredDecisionDocumentRowsSchema,
  strictParseOptions,
)

export const decodeStoredDecisionDocumentRows = Pipeable.dual(1, (input: unknown) =>
  decodeStoredDecisionDocumentRowsDataFirst(input),
)

const decodeAutonomousCycleResult = Schema.decodeUnknownEffect(AutonomousCycleSchema, strictParseOptions)
const decodeStoredCycleRowValuesResult = Schema.decodeUnknownResult(
  Schema.Array(StoredCycleRowSchema),
  strictParseOptions,
)

export const decodeStoredCycleRowValues = (
  rows: unknown,
): Result.Result<readonly (typeof StoredCycleRowSchema.Type)[], Schema.SchemaError> =>
  decodeStoredCycleRowValuesResult(rows)

const storedExecutionPolicy = (row: typeof StoredCycleRowSchema.Type) => {
  const policyMaterial = {
    schemaVersion: row.execution_policy_schema_version,
    strategyExecutionModelHash: row.strategy_execution_model_hash,
    submissionWindowMs: row.submission_window_ms,
    executionPolicyHash: row.execution_policy_hash,
  } as const
  if (row.execution_policy_schema_version === 'bayn.autonomous-cycle-execution-policy.v1') {
    return { ...policyMaterial, submissionCutoffBeforeOpenMs: row.submission_cutoff_before_open_ms }
  }
  if (row.execution_policy_schema_version === 'bayn.autonomous-cycle-execution-policy.v3') {
    const { submissionWindowMs: _, ...rollingPolicyMaterial } = policyMaterial
    return {
      ...rollingPolicyMaterial,
      warmupAfterOpenMs: row.warmup_after_open_ms,
      submissionCutoffBeforeCloseMs: row.submission_cutoff_before_close_ms,
    }
  }
  return {
    ...policyMaterial,
    // Version 2 predates the dedicated after-open column and persisted this value in the historical column.
    submissionCutoffAfterOpenMs:
      row.schema_version === 'bayn.autonomous-cycle.v2'
        ? row.submission_cutoff_before_open_ms
        : row.submission_cutoff_after_open_ms,
  }
}

const rowToCycle = (row: typeof StoredCycleRowSchema.Type) =>
  decodeAutonomousCycleResult({
    schemaVersion: row.schema_version,
    identity: {
      schemaVersion: row.identity_schema_version,
      strategyName: row.strategy_name,
      qualificationRunId: row.qualification_run_id,
      strategyProtocolHash: row.strategy_protocol_hash,
      accountId: row.account_id,
      ...(row.identity_schema_version !== 'bayn.autonomous-cycle-identity.v3'
        ? {
            signalSessionDate: row.signal_session_date,
            signalCalendarVersion: row.signal_calendar_version,
          }
        : {}),
      executionSessionDate: row.execution_session_date,
      executionCalendarSchemaVersion: row.execution_calendar_schema_version,
      executionCalendarSource: row.execution_calendar_source,
      executionCalendarHash: row.execution_calendar_hash,
      executionPolicy: storedExecutionPolicy(row),
      cycleId: row.cycle_id,
    },
    window: {
      schemaVersion: row.window_schema_version,
      ...(row.window_schema_version !== 'bayn.autonomous-cycle-window.v3'
        ? {
            signalCalendarVersion: row.signal_calendar_version,
            signalSessionDate: row.signal_session_date,
            signalCloseAt: row.signal_close_at?.toISOString(),
            publicationDeadlineAt: row.publication_deadline_at?.toISOString(),
          }
        : {}),
      executionCalendarSchemaVersion: row.execution_calendar_schema_version,
      executionCalendarSource: row.execution_calendar_source,
      executionCalendarHash: row.execution_calendar_hash,
      executionSessionDate: row.execution_session_date,
      submissionOpenAt: row.submission_open_at.toISOString(),
      executionOpenAt: row.execution_open_at.toISOString(),
      executionCloseAt: row.execution_close_at.toISOString(),
      submissionCutoffAt: row.submission_cutoff_at.toISOString(),
    },
    state: row.state,
    bindings: {
      ...(row.snapshot_id === null ? {} : { snapshotId: row.snapshot_id }),
      ...(row.decision_hash === null ? {} : { decisionHash: row.decision_hash }),
    },
    ...(row.terminal_reason === null ? {} : { terminalReason: row.terminal_reason }),
    stateVersion: row.state_version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.terminal_at === null ? {} : { terminalAt: row.terminal_at.toISOString() }),
  })

export const decodeStoredCycles = (
  rows: readonly Record<string, unknown>[],
): Effect.Effect<readonly AutonomousCycle[], Schema.SchemaError> =>
  Effect.fromResult(decodeStoredCycleRowValues(rows)).pipe(
    Effect.flatMap((decoded) => Effect.all(decoded.map(rowToCycle))),
  )
