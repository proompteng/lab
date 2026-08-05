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

export const decodeEventInput = Schema.decodeUnknownEffect(BrokerEventInputSchema, strictParseOptions)
export const decodeFillInput = Schema.decodeUnknownEffect(FillEventInputSchema, strictParseOptions)
export const decodePositionSnapshotInput = Schema.decodeUnknownEffect(PositionSnapshotInputSchema, strictParseOptions)
export const decodeValuationInput = Schema.decodeUnknownEffect(ValuationInputSchema, strictParseOptions)
export const decodeEventRows = Schema.decodeUnknownEffect(Schema.Array(EventRow), strictParseOptions)
export const decodeLastSequence = Schema.decodeUnknownEffect(LastSequenceRow, strictParseOptions)
export const decodePositionCost = Schema.decodeUnknownEffect(PositionCostRow, strictParseOptions)
export const decodeUnresolvedPredecessor = Schema.decodeUnknownEffect(UnresolvedPredecessorRow, strictParseOptions)
export const decodeAccountBaseline = Schema.decodeUnknownEffect(AccountBaselineRow, strictParseOptions)
export const decodeAccountId = Schema.decodeUnknownEffect(NonEmptyString, strictParseOptions)
export const decodeTransactionRows = Schema.decodeUnknownEffect(
  Schema.Array(AccountingTransactionRowSchema),
  strictParseOptions,
)
export const decodeReceiptRows = Schema.decodeUnknownEffect(
  Schema.Array(AccountingReceiptRowSchema),
  strictParseOptions,
)
export const decodeAccountRows = Schema.decodeUnknownEffect(AccountRow, strictParseOptions)
export const decodePositionRows = Schema.decodeUnknownEffect(Schema.Array(PositionRow), strictParseOptions)
export const decodePositionSnapshotRows = Schema.decodeUnknownEffect(
  Schema.Array(PositionSnapshotRow),
  strictParseOptions,
)
export const decodeEventIdRows = Schema.decodeUnknownEffect(Schema.Array(EventIdRow), strictParseOptions)
export const decodeSnapshotIdRows = Schema.decodeUnknownEffect(Schema.Array(SnapshotIdRow), strictParseOptions)
export const decodeValuationRows = Schema.decodeUnknownEffect(Schema.Array(ValuationRow), strictParseOptions)
export const decodeEnsureAuthorityGenerationInput = Schema.decodeUnknownEffect(
  EnsureAuthorityGenerationInputSchema,
  strictParseOptions,
)
export const decodeAuthorityStateRows = Schema.decodeUnknownEffect(AuthorityStateRows, strictParseOptions)
export const decodeAuthorityStateObservationRows = Schema.decodeUnknownEffect(
  AuthorityStateObservationRows,
  strictParseOptions,
)
export const decodeAuthorityGenerationRows = Schema.decodeUnknownEffect(AuthorityGenerationRows, strictParseOptions)
export const decodeActivationEvidenceRows = Schema.decodeUnknownEffect(ActivationEvidenceRows, strictParseOptions)
export const decodeActivationReconciliationRows = Schema.decodeUnknownEffect(
  ActivationReconciliationRows,
  strictParseOptions,
)
export const decodeMutationBaseline = Schema.decodeUnknownEffect(MutationBaselineRow, strictParseOptions)
export const decodeDatabaseInstant = Schema.decodeUnknownEffect(DatabaseInstantRow, strictParseOptions)
export const decodeBrokerEvent = Schema.decodeUnknownEffect(BrokerEventSchema, strictParseOptions)
export const decodeReceipt = Schema.decodeUnknownEffect(AccountingReceiptSchema, strictParseOptions)
export const decodeValuation = Schema.decodeUnknownEffect(ValuationSchema, strictParseOptions)
export const decodeTransaction = Schema.decodeUnknownEffect(AccountingTransactionSchema, strictParseOptions)
export const decodeAuthorityRestriction = Schema.decodeUnknownEffect(AuthorityRestrictionInput, strictParseOptions)
