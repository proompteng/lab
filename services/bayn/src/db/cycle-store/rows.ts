import { Effect, Result, Schema } from 'effect'

import {
  AutonomousCycleSchema,
  CycleDraftSchema,
  CycleState,
  CycleTerminalReason,
  type AutonomousCycle,
} from '../../cycle'
import {
  IsoDateSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../../schemas'
import { CycleDecisionDocumentSchema } from '../../shadow-decision-contract'

const StoredCycleRowSchema = Schema.Struct({
  cycle_id: Sha256Schema,
  schema_version: Schema.Literal('bayn.autonomous-cycle.v1'),
  identity_schema_version: Schema.Literal('bayn.autonomous-cycle-identity.v1'),
  strategy_name: Schema.Literal('risk-balanced-trend'),
  qualification_run_id: Sha256Schema,
  strategy_protocol_hash: Sha256Schema,
  account_id: StrictNonEmptyStringSchema,
  signal_session_date: IsoDateSchema,
  signal_calendar_version: StrictNonEmptyStringSchema,
  execution_policy_schema_version: Schema.Literal('bayn.autonomous-cycle-execution-policy.v1'),
  execution_policy_hash: Sha256Schema,
  strategy_execution_model_hash: Sha256Schema,
  submission_window_ms: PositiveIntegerSchema,
  submission_cutoff_before_open_ms: PositiveIntegerSchema,
  window_schema_version: Schema.Literal('bayn.autonomous-cycle-window.v1'),
  execution_calendar_schema_version: Schema.Literal('bayn.alpaca-market-calendar-observation.v1'),
  execution_calendar_source: Schema.Literal('alpaca-v2-calendar'),
  execution_calendar_hash: Sha256Schema,
  execution_session_date: IsoDateSchema,
  signal_close_at: Schema.Date,
  publication_deadline_at: Schema.Date,
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
const CycleAuthoritySlotSchema = Schema.Struct({
  qualificationRunId: Sha256Schema,
  accountId: StrictNonEmptyStringSchema,
  signalSessionDate: IsoDateSchema,
})
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
    paper_completion_evidence_matches: Schema.Boolean,
    paper_generation_is_superseded: Schema.Boolean,
  }),
)

export const decodeCycleId = Schema.decodeUnknownEffect(Sha256Schema, strictParseOptions)
export const decodeCycleIdInput = Schema.decodeUnknownEffect(CycleIdInputSchema, strictParseOptions)
export const decodeCycleAuthoritySlot = Schema.decodeUnknownEffect(CycleAuthoritySlotSchema, strictParseOptions)
export const decodeCycleRecoveryScope = Schema.decodeUnknownEffect(CycleRecoveryScopeSchema, strictParseOptions)
export const decodeSnapshotInput = Schema.decodeUnknownEffect(SnapshotInputSchema, strictParseOptions)
export const decodeDecisionInput = Schema.decodeUnknownEffect(DecisionInputSchema, strictParseOptions)
export const decodeBlockInput = Schema.decodeUnknownEffect(BlockInputSchema, strictParseOptions)
export const decodeFinishInput = Schema.decodeUnknownEffect(FinishInputSchema, strictParseOptions)
export const decodeCycleDraft = Schema.decodeUnknownEffect(CycleDraftSchema, strictParseOptions)
export const decodeObservedAt = Schema.decodeUnknownEffect(UtcInstantSchema, strictParseOptions)
export const decodeMutationRows = Schema.decodeUnknownEffect(MutationRowsSchema, strictParseOptions)
export const decodeDecisionEvidenceMatch = Schema.decodeUnknownEffect(DecisionEvidenceMatchSchema, strictParseOptions)
export const decodeStoredDecisionDocumentRows = Schema.decodeUnknownEffect(
  StoredDecisionDocumentRowsSchema,
  strictParseOptions,
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

const rowToCycle = (row: typeof StoredCycleRowSchema.Type) =>
  decodeAutonomousCycleResult({
    schemaVersion: row.schema_version,
    identity: {
      schemaVersion: row.identity_schema_version,
      strategyName: row.strategy_name,
      qualificationRunId: row.qualification_run_id,
      strategyProtocolHash: row.strategy_protocol_hash,
      accountId: row.account_id,
      signalSessionDate: row.signal_session_date,
      signalCalendarVersion: row.signal_calendar_version,
      executionSessionDate: row.execution_session_date,
      executionCalendarSchemaVersion: row.execution_calendar_schema_version,
      executionCalendarSource: row.execution_calendar_source,
      executionCalendarHash: row.execution_calendar_hash,
      executionPolicy: {
        schemaVersion: row.execution_policy_schema_version,
        strategyExecutionModelHash: row.strategy_execution_model_hash,
        submissionWindowMs: row.submission_window_ms,
        submissionCutoffBeforeOpenMs: row.submission_cutoff_before_open_ms,
        executionPolicyHash: row.execution_policy_hash,
      },
      cycleId: row.cycle_id,
    },
    window: {
      schemaVersion: row.window_schema_version,
      signalCalendarVersion: row.signal_calendar_version,
      signalSessionDate: row.signal_session_date,
      executionCalendarSchemaVersion: row.execution_calendar_schema_version,
      executionCalendarSource: row.execution_calendar_source,
      executionCalendarHash: row.execution_calendar_hash,
      executionSessionDate: row.execution_session_date,
      signalCloseAt: row.signal_close_at.toISOString(),
      publicationDeadlineAt: row.publication_deadline_at.toISOString(),
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
