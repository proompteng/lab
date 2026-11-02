import { Effect, Schema } from 'effect'

import {
  IsoDateSchema,
  NonNegativeIntegerSchema,
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
import { DecisionEvidenceMismatch } from './model'

const StoredCycleRowSchema = Schema.Struct({
  cycle_id: Sha256Schema,
  schema_version: Schema.Literal('bayn.autonomous-cycle.v4'),
  identity_schema_version: Schema.Literal('bayn.autonomous-cycle-identity.v4'),
  strategy_name: Schema.Literal('jev'),
  qualification_run_id: Sha256Schema,
  strategy_protocol_hash: Sha256Schema,
  account_id: StrictNonEmptyStringSchema,
  entry_attempt_ordinal: PositiveIntegerSchema,
  signal_session_date: Schema.NullOr(IsoDateSchema),
  signal_calendar_version: Schema.NullOr(StrictNonEmptyStringSchema),
  execution_policy_schema_version: Schema.Literal('bayn.autonomous-cycle-execution-policy.v3'),
  execution_policy_hash: Sha256Schema,
  strategy_execution_model_hash: Sha256Schema,
  submission_window_ms: PositiveIntegerSchema,
  submission_cutoff_before_open_ms: Schema.NullOr(PositiveIntegerSchema),
  submission_cutoff_after_open_ms: Schema.NullOr(PositiveIntegerSchema),
  warmup_after_open_ms: Schema.NullOr(NonNegativeIntegerSchema),
  submission_cutoff_before_close_ms: Schema.NullOr(NonNegativeIntegerSchema),
  window_schema_version: Schema.Literal('bayn.autonomous-cycle-window.v3'),
  execution_calendar_schema_version: Schema.Literals([
    'bayn.alpaca-market-calendar-observation.v2',
    'bayn.continuous-market-hours.v1',
  ]),
  execution_calendar_source: Schema.Literals(['alpaca-v2-calendar', 'alpaca-crypto-us']),
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
const CycleAuthoritySlotSchema = Schema.Struct({
  ...CycleAuthoritySlotScopeFields,
  executionSessionDate: IsoDateSchema,
})
const CycleRecoveryScopeSchema = Schema.Struct({
  qualificationRunId: Sha256Schema,
  accountId: StrictNonEmptyStringSchema,
})
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
const DecisionEvidenceMismatchSchema = Schema.Tuple([
  Schema.Struct({ mismatch: Schema.NullOr(Schema.Enum(DecisionEvidenceMismatch)) }),
])
const StoredDecisionDocumentRowsSchema = Schema.Array(
  Schema.Struct({
    document: Schema.Unknown,
    matches_retained_document: Schema.Boolean,
    execution_completion_evidence_matches: Schema.Boolean,
    execution_generation_is_superseded: Schema.Boolean,
  }),
)

export const decodeCycleId = Schema.decodeUnknownEffect(Sha256Schema, strictParseOptions)

export const decodeCycleIdInput = Schema.decodeUnknownEffect(CycleIdInputSchema, strictParseOptions)

export const decodeCycleAuthoritySlot = Schema.decodeUnknownEffect(CycleAuthoritySlotSchema, strictParseOptions)

export const decodeCycleRecoveryScope = Schema.decodeUnknownEffect(CycleRecoveryScopeSchema, strictParseOptions)

export const decodeDecisionInput = Schema.decodeUnknownEffect(DecisionInputSchema, strictParseOptions)

export const decodeBlockInput = Schema.decodeUnknownEffect(BlockInputSchema, strictParseOptions)

export const decodeFinishInput = Schema.decodeUnknownEffect(FinishInputSchema, strictParseOptions)

export const decodeCycleDraft = Schema.decodeUnknownEffect(CycleDraftSchema, strictParseOptions)

export const decodeObservedAt = Schema.decodeUnknownEffect(UtcInstantSchema, strictParseOptions)

export const decodeMutationRows = Schema.decodeUnknownEffect(MutationRowsSchema, strictParseOptions)

export const decodeDecisionEvidenceMatch = Schema.decodeUnknownEffect(DecisionEvidenceMatchSchema, strictParseOptions)
export const decodeDecisionEvidenceMismatch = Schema.decodeUnknownEffect(
  DecisionEvidenceMismatchSchema,
  strictParseOptions,
)

export const decodeStoredDecisionDocumentRows = Schema.decodeUnknownEffect(
  StoredDecisionDocumentRowsSchema,
  strictParseOptions,
)

const decodeAutonomousCycleResult = Schema.decodeUnknownEffect(AutonomousCycleSchema, strictParseOptions)

export const decodeStoredCycleRowValues = Schema.decodeUnknownResult(
  Schema.Array(StoredCycleRowSchema),
  strictParseOptions,
)

const storedExecutionPolicy = (row: typeof StoredCycleRowSchema.Type) => ({
  schemaVersion: row.execution_policy_schema_version,
  strategyExecutionModelHash: row.strategy_execution_model_hash,
  executionPolicyHash: row.execution_policy_hash,
  warmupAfterOpenMs: row.warmup_after_open_ms,
  submissionCutoffBeforeCloseMs: row.submission_cutoff_before_close_ms,
})

const rowToCycle = (row: typeof StoredCycleRowSchema.Type) =>
  decodeAutonomousCycleResult({
    schemaVersion: row.schema_version,
    identity: {
      schemaVersion: row.identity_schema_version,
      strategyName: row.strategy_name,
      qualificationRunId: row.qualification_run_id,
      strategyProtocolHash: row.strategy_protocol_hash,
      accountId: row.account_id,
      entryAttemptOrdinal: row.entry_attempt_ordinal,
      executionSessionDate: row.execution_session_date,
      executionCalendarSchemaVersion: row.execution_calendar_schema_version,
      executionCalendarSource: row.execution_calendar_source,
      executionCalendarHash: row.execution_calendar_hash,
      executionPolicy: storedExecutionPolicy(row),
      cycleId: row.cycle_id,
    },
    window: {
      schemaVersion: row.window_schema_version,
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
