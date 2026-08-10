import { Schema } from 'effect'

import { AccountingTransactionSchema } from '../../accounting/schema'
import {
  BrokerEventInputSchema,
  FillEventInputSchema,
  PositionSnapshotInputSchema,
  ValuationInputSchema,
} from '../../broker/observations'
import { BrokerEnvironmentSchema, BrokerProviderSchema } from '../../broker/identity'
import {
  AccountingReceiptSchema,
  Authority,
  BrokerEventSchema,
  KillState,
  ReconciliationStatus,
  ValuationSchema,
} from '../../execution/contracts'
import { QualificationLockSchema, QualificationResultSchema } from '../../qualification'
import {
  Sha256Schema as Sha256,
  StrictNonEmptyStringSchema as NonEmptyString,
  UtcInstantSchema as UtcInstant,
  strictParseOptions,
} from '../../schemas'
import { AccountingReceiptRowSchema, AccountingTransactionRowSchema } from '../accounting-rows'
import { Pipeable } from '../../pipeable'

export const EventKind = Schema.Literals(['ACCOUNT', 'POSITION', 'ORDER', 'FILL'])
export const EventRow = Schema.Struct({
  event_id: Sha256,
  event_kind: EventKind,
  content_hash: Sha256,
  source_sequence: Schema.String,
})
export type EventRow = typeof EventRow.Type

export const LastSequenceRow = Schema.Tuple([Schema.Struct({ last_sequence: Schema.String })])
export const PositionCostRow = Schema.Tuple([
  Schema.Struct({ quantity_micros: Schema.String, cost_micros: Schema.String }),
])
export const UnresolvedPredecessorRow = Schema.Tuple([Schema.Struct({ unresolved: Schema.Boolean })])
export const AccountBaselineRow = Schema.Tuple([Schema.Struct({ exists: Schema.Boolean })])
export const AccountRow = Schema.Tuple([
  Schema.Struct({
    event_id: Sha256,
    account_id: NonEmptyString,
    cash_micros: Schema.String,
    observed_at: Schema.Date,
  }),
])
export type AccountRow = (typeof AccountRow.Type)[0]

export const PositionRow = Schema.Struct({
  event_id: Sha256,
  account_id: NonEmptyString,
  source_event_id: NonEmptyString,
  symbol: Schema.String,
  market_value_micros: Schema.String,
  observed_at: Schema.Date,
})
export type PositionRow = typeof PositionRow.Type

export const PositionSnapshotRow = Schema.Struct({
  snapshot_id: Sha256,
  schema_version: Schema.Literal('bayn.paper-position-snapshot.v1'),
  account_id: NonEmptyString,
  source_hash: Sha256,
  observed_at: Schema.Date,
  position_count: Schema.Int,
  content_hash: Sha256,
})
export type PositionSnapshotRow = typeof PositionSnapshotRow.Type

export const EventIdRow = Schema.Struct({ event_id: Sha256 })
export type EventIdRow = typeof EventIdRow.Type

export const SnapshotIdRow = Schema.Struct({ snapshot_id: Sha256 })
export const ValuationRow = Schema.Struct({
  schema_version: Schema.Literal('bayn.paper-valuation.v1'),
  valuation_id: Sha256,
  account_id: NonEmptyString,
  source_hash: Sha256,
  cash_micros: Schema.String,
  long_market_value_micros: Schema.String,
  short_market_value_micros: Schema.String,
  equity_micros: Schema.String,
  as_of: Schema.Date,
})
export type ValuationRow = typeof ValuationRow.Type

export const EnsureAuthorityGenerationInputSchema = Schema.Struct({
  generationHash: Sha256,
  maximum: Schema.Enum(Authority),
})
export const AuthorityStateRow = Schema.Struct({
  schema_version: Schema.Literal('bayn.paper-authority.v1'),
  generation_hash: Sha256,
  maximum: Schema.Enum(Authority),
  effective: Schema.Enum(Authority),
  kill_state: Schema.Enum(KillState),
  reason: Schema.NullOr(NonEmptyString),
  version: Schema.String,
  updated_at: Schema.Date,
})
export type AuthorityStateRow = typeof AuthorityStateRow.Type

export const AuthorityStateObservationRow = Schema.Struct({
  ...AuthorityStateRow.fields,
  observed_at: Schema.Date,
})
export type AuthorityStateObservationRow = typeof AuthorityStateObservationRow.Type

export const AuthorityStateRows = Schema.Array(AuthorityStateRow).check(Schema.isMaxLength(1))
export const AuthorityStateObservationRows = Schema.Array(AuthorityStateObservationRow).check(Schema.isMaxLength(1))
export const AuthorityGenerationRow = Schema.Struct({
  generation_hash: Sha256,
  activation_schema_version: Schema.NullOr(
    Schema.Literals(['bayn.paper-authority-generation.v2', 'bayn.paper-authority-generation.v3']),
  ),
  previous_generation_hash: Schema.NullOr(Sha256),
  maximum: Schema.Enum(Authority),
  authority_version: Schema.String,
  broker_identity_schema_version: Schema.NullOr(Schema.Literal('bayn.broker-identity.v2')),
  broker_identity_hash: Schema.NullOr(Sha256),
  broker_provider: Schema.NullOr(BrokerProviderSchema),
  broker_environment: Schema.NullOr(BrokerEnvironmentSchema),
  qualification_run_id: Schema.NullOr(Sha256),
  qualification_lock_id: Schema.NullOr(Sha256),
  qualification_result_hash: Schema.NullOr(Sha256),
  protocol_hash: Schema.NullOr(Sha256),
  qualification_execution_policy_hash: Schema.NullOr(Sha256),
  qualification_source_revision: Schema.NullOr(Schema.String),
  qualification_image_repository: Schema.NullOr(NonEmptyString),
  qualification_image_digest: Schema.NullOr(Schema.String),
  activation_source_revision: Schema.NullOr(Schema.String),
  activation_image_repository: Schema.NullOr(NonEmptyString),
  activation_image_digest: Schema.NullOr(Schema.String),
  strategy_name: Schema.NullOr(Schema.Literal('risk-balanced-trend')),
  strategy_behavior_hash: Schema.NullOr(Sha256),
  strategy_parameter_hash: Schema.NullOr(Sha256),
  strategy_parameter_schema_version: Schema.NullOr(
    Schema.Literals(['bayn.risk-balanced-trend.protocol.v3', 'bayn.risk-balanced-trend.protocol.v4']),
  ),
  account_id: Schema.NullOr(NonEmptyString),
  risk_policy_hash: Schema.NullOr(Sha256),
  proof_plan_hash: Schema.NullOr(Sha256),
  reconciliation_id: Schema.NullOr(Sha256),
  reconciliation_content_hash: Schema.NullOr(Sha256),
  research_plan_hash: Schema.NullOr(Sha256),
  strategy_protocol_hash: Schema.NullOr(Sha256),
  activated_at: Schema.Date,
})
export type AuthorityGenerationRow = typeof AuthorityGenerationRow.Type

export const AuthorityGenerationRows = Schema.Array(AuthorityGenerationRow).check(Schema.isMaxLength(1))
export const ActivationEvidenceRow = Schema.Struct({
  lock_payload: QualificationLockSchema,
  result_payload: QualificationResultSchema,
  run_status: Schema.Literals(['WRITING', 'COMPLETE']),
  expected_artifact_count: Schema.Int,
  expected_event_count: Schema.Int,
  expected_gate_count: Schema.Int,
  artifact_count: Schema.Int,
  event_count: Schema.Int,
  gate_count: Schema.Int,
  status_count: Schema.Int,
  writing_status_count: Schema.Int,
  complete_status_count: Schema.Int,
  writing_detail: Schema.Unknown,
  complete_detail: Schema.Unknown,
  protocol_schema_version: Schema.Literals([
    'bayn.risk-balanced-trend.protocol.v2',
    'bayn.risk-balanced-trend.protocol.v3',
    'bayn.risk-balanced-trend.protocol.v4',
  ]),
  strategy_name: Schema.Literal('risk-balanced-trend'),
  behavior_hash: Sha256,
  parameter_hash: Sha256,
  parameters: Schema.Unknown,
})
export type ActivationEvidenceRow = typeof ActivationEvidenceRow.Type

export const ActivationEvidenceRows = Schema.Array(ActivationEvidenceRow).check(Schema.isMaxLength(1))
export const ActivationReconciliationRow = Schema.Struct({
  reconciliation_id: Sha256,
  account_id: NonEmptyString,
  content_hash: Sha256,
  status: Schema.Enum(ReconciliationStatus),
  reconciled_at: Schema.Date,
})
export type ActivationReconciliationRow = typeof ActivationReconciliationRow.Type

export const ActivationReconciliationRows = Schema.Array(ActivationReconciliationRow).check(Schema.isMaxLength(1))
export const MutationBaselineRow = Schema.Tuple([
  Schema.Struct({
    unresolved_count: Schema.Int,
    latest_mutation_at: Schema.NullOr(Schema.Date),
  }),
])
export const DatabaseInstantRow = Schema.Tuple([Schema.Struct({ activated_at: Schema.Date })])
export const AuthorityRestrictionInput = Schema.Struct({ reason: NonEmptyString, updatedAt: UtcInstant })

const decodeEventInputDataFirst = Schema.decodeUnknownEffect(BrokerEventInputSchema, strictParseOptions)

export const decodeEventInput = Pipeable.dual(1, (input: unknown) => decodeEventInputDataFirst(input))
const decodeFillInputDataFirst = Schema.decodeUnknownEffect(FillEventInputSchema, strictParseOptions)

export const decodeFillInput = Pipeable.dual(1, (input: unknown) => decodeFillInputDataFirst(input))
const decodePositionSnapshotInputDataFirst = Schema.decodeUnknownEffect(PositionSnapshotInputSchema, strictParseOptions)

export const decodePositionSnapshotInput = Pipeable.dual(1, (input: unknown) =>
  decodePositionSnapshotInputDataFirst(input),
)
const decodeValuationInputDataFirst = Schema.decodeUnknownEffect(ValuationInputSchema, strictParseOptions)

export const decodeValuationInput = Pipeable.dual(1, (input: unknown) => decodeValuationInputDataFirst(input))
const decodeEventRowsDataFirst = Schema.decodeUnknownEffect(Schema.Array(EventRow), strictParseOptions)

export const decodeEventRows = Pipeable.dual(1, (input: unknown) => decodeEventRowsDataFirst(input))
const decodeLastSequenceDataFirst = Schema.decodeUnknownEffect(LastSequenceRow, strictParseOptions)

export const decodeLastSequence = Pipeable.dual(1, (input: unknown) => decodeLastSequenceDataFirst(input))
const decodePositionCostDataFirst = Schema.decodeUnknownEffect(PositionCostRow, strictParseOptions)

export const decodePositionCost = Pipeable.dual(1, (input: unknown) => decodePositionCostDataFirst(input))
const decodeUnresolvedPredecessorDataFirst = Schema.decodeUnknownEffect(UnresolvedPredecessorRow, strictParseOptions)

export const decodeUnresolvedPredecessor = Pipeable.dual(1, (input: unknown) =>
  decodeUnresolvedPredecessorDataFirst(input),
)
const decodeAccountBaselineDataFirst = Schema.decodeUnknownEffect(AccountBaselineRow, strictParseOptions)

export const decodeAccountBaseline = Pipeable.dual(1, (input: unknown) => decodeAccountBaselineDataFirst(input))
const decodeAccountIdDataFirst = Schema.decodeUnknownEffect(NonEmptyString, strictParseOptions)

export const decodeAccountId = Pipeable.dual(1, (input: unknown) => decodeAccountIdDataFirst(input))
const decodeTransactionRowsDataFirst = Schema.decodeUnknownEffect(
  Schema.Array(AccountingTransactionRowSchema),
  strictParseOptions,
)

export const decodeTransactionRows = Pipeable.dual(1, (input: unknown) => decodeTransactionRowsDataFirst(input))
const decodeReceiptRowsDataFirst = Schema.decodeUnknownEffect(
  Schema.Array(AccountingReceiptRowSchema),
  strictParseOptions,
)

export const decodeReceiptRows = Pipeable.dual(1, (input: unknown) => decodeReceiptRowsDataFirst(input))
const decodeAccountRowsDataFirst = Schema.decodeUnknownEffect(AccountRow, strictParseOptions)

export const decodeAccountRows = Pipeable.dual(1, (input: unknown) => decodeAccountRowsDataFirst(input))
const decodePositionRowsDataFirst = Schema.decodeUnknownEffect(Schema.Array(PositionRow), strictParseOptions)

export const decodePositionRows = Pipeable.dual(1, (input: unknown) => decodePositionRowsDataFirst(input))
const decodePositionSnapshotRowsDataFirst = Schema.decodeUnknownEffect(
  Schema.Array(PositionSnapshotRow),
  strictParseOptions,
)

export const decodePositionSnapshotRows = Pipeable.dual(1, (input: unknown) =>
  decodePositionSnapshotRowsDataFirst(input),
)
const decodeEventIdRowsDataFirst = Schema.decodeUnknownEffect(Schema.Array(EventIdRow), strictParseOptions)

export const decodeEventIdRows = Pipeable.dual(1, (input: unknown) => decodeEventIdRowsDataFirst(input))
const decodeSnapshotIdRowsDataFirst = Schema.decodeUnknownEffect(Schema.Array(SnapshotIdRow), strictParseOptions)

export const decodeSnapshotIdRows = Pipeable.dual(1, (input: unknown) => decodeSnapshotIdRowsDataFirst(input))
const decodeValuationRowsDataFirst = Schema.decodeUnknownEffect(Schema.Array(ValuationRow), strictParseOptions)

export const decodeValuationRows = Pipeable.dual(1, (input: unknown) => decodeValuationRowsDataFirst(input))
const decodeEnsureAuthorityGenerationInputDataFirst = Schema.decodeUnknownEffect(
  EnsureAuthorityGenerationInputSchema,
  strictParseOptions,
)

export const decodeEnsureAuthorityGenerationInput = Pipeable.dual(1, (input: unknown) =>
  decodeEnsureAuthorityGenerationInputDataFirst(input),
)
const decodeAuthorityStateRowsDataFirst = Schema.decodeUnknownEffect(AuthorityStateRows, strictParseOptions)

export const decodeAuthorityStateRows = Pipeable.dual(1, (input: unknown) => decodeAuthorityStateRowsDataFirst(input))
const decodeAuthorityStateObservationRowsDataFirst = Schema.decodeUnknownEffect(
  AuthorityStateObservationRows,
  strictParseOptions,
)

export const decodeAuthorityStateObservationRows = Pipeable.dual(1, (input: unknown) =>
  decodeAuthorityStateObservationRowsDataFirst(input),
)
const decodeAuthorityGenerationRowsDataFirst = Schema.decodeUnknownEffect(AuthorityGenerationRows, strictParseOptions)

export const decodeAuthorityGenerationRows = Pipeable.dual(1, (input: unknown) =>
  decodeAuthorityGenerationRowsDataFirst(input),
)
const decodeActivationEvidenceRowsDataFirst = Schema.decodeUnknownEffect(ActivationEvidenceRows, strictParseOptions)

export const decodeActivationEvidenceRows = Pipeable.dual(1, (input: unknown) =>
  decodeActivationEvidenceRowsDataFirst(input),
)
const decodeActivationReconciliationRowsDataFirst = Schema.decodeUnknownEffect(
  ActivationReconciliationRows,
  strictParseOptions,
)

export const decodeActivationReconciliationRows = Pipeable.dual(1, (input: unknown) =>
  decodeActivationReconciliationRowsDataFirst(input),
)
const decodeMutationBaselineDataFirst = Schema.decodeUnknownEffect(MutationBaselineRow, strictParseOptions)

export const decodeMutationBaseline = Pipeable.dual(1, (input: unknown) => decodeMutationBaselineDataFirst(input))
const decodeDatabaseInstantDataFirst = Schema.decodeUnknownEffect(DatabaseInstantRow, strictParseOptions)

export const decodeDatabaseInstant = Pipeable.dual(1, (input: unknown) => decodeDatabaseInstantDataFirst(input))
const decodeBrokerEventDataFirst = Schema.decodeUnknownEffect(BrokerEventSchema, strictParseOptions)

export const decodeBrokerEvent = Pipeable.dual(1, (input: unknown) => decodeBrokerEventDataFirst(input))
const decodeReceiptDataFirst = Schema.decodeUnknownEffect(AccountingReceiptSchema, strictParseOptions)

export const decodeReceipt = Pipeable.dual(1, (input: unknown) => decodeReceiptDataFirst(input))
const decodeValuationDataFirst = Schema.decodeUnknownEffect(ValuationSchema, strictParseOptions)

export const decodeValuation = Pipeable.dual(1, (input: unknown) => decodeValuationDataFirst(input))
const decodeTransactionDataFirst = Schema.decodeUnknownEffect(AccountingTransactionSchema, strictParseOptions)

export const decodeTransaction = Pipeable.dual(1, (input: unknown) => decodeTransactionDataFirst(input))
const decodeAuthorityRestrictionDataFirst = Schema.decodeUnknownEffect(AuthorityRestrictionInput, strictParseOptions)

export const decodeAuthorityRestriction = Pipeable.dual(1, (input: unknown) =>
  decodeAuthorityRestrictionDataFirst(input),
)
