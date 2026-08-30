import { Result } from 'effect'

import { planDecodedLedgerInput } from './ledger-plan/build'
import { hashLedgerPlanResult } from './ledger-plan/hash'
import { decodeLedgerInput } from './ledger-plan/input'
import {
  AccountCode,
  failLedgerValidation,
  ledgerValidationError,
  LEDGER_ACCOUNT_HISTORY_FLAG,
  LEDGER_BATCH_MAX,
  LEDGER_SCHEMA_VERSION,
  LedgerValidationError,
  makeLedgerPlanFailure,
  renderLedgerPlanFailure,
  TransferCode,
  type LedgerAccountRecord,
  type LedgerCreateOutcome,
  type LedgerCreateResult,
  type LedgerQueryFilter,
  type EvaluationLedgerPlan,
  type LedgerInput,
  type LedgerPlan,
  type LedgerPlanAmountField,
  type LedgerPlanFailure,
  type LedgerPlanFailureDetail,
  type LedgerPlanHashFailure,
  type LedgerPlanInputField,
  type LedgerValidationOperation,
  type LedgerValidationReason,
  type LedgerTransferRecord,
} from './ledger-plan/model'
import { validatePersistedRunEvidence } from './ledger-plan/persisted-evidence'
import {
  accountMetadataMatches,
  preflightTransfers,
  reconcileLedgerPlan,
  transferMetadataMatches,
  verifyExactAccounts,
  verifyExactTransfers,
  verifyLedgerPlanRecords,
} from './ledger-plan/verification'
import { Pipeable } from './pipeable'

const buildLedgerPlanDataFirst = (
  input: unknown,
  ledger: number,
): Result.Result<EvaluationLedgerPlan, LedgerPlanFailure> =>
  Result.mapError(
    Result.flatMap(decodeLedgerInput(input), (decoded) => planDecodedLedgerInput(decoded, ledger)),
    (failure) => makeLedgerPlanFailure(ledger, failure),
  )

export const buildLedgerPlan = Pipeable.dual(2, buildLedgerPlanDataFirst)

export {
  AccountCode,
  accountMetadataMatches,
  failLedgerValidation,
  hashLedgerPlanResult,
  ledgerValidationError,
  LEDGER_ACCOUNT_HISTORY_FLAG,
  LEDGER_BATCH_MAX,
  LEDGER_SCHEMA_VERSION,
  LedgerValidationError,
  preflightTransfers,
  reconcileLedgerPlan,
  renderLedgerPlanFailure,
  TransferCode,
  transferMetadataMatches,
  validatePersistedRunEvidence,
  verifyExactAccounts,
  verifyExactTransfers,
  verifyLedgerPlanRecords,
}

export type {
  EvaluationLedgerPlan,
  LedgerInput,
  LedgerAccountRecord,
  LedgerCreateOutcome,
  LedgerCreateResult,
  LedgerQueryFilter,
  LedgerPlan,
  LedgerPlanAmountField,
  LedgerPlanFailure,
  LedgerPlanFailureDetail,
  LedgerPlanHashFailure,
  LedgerPlanInputField,
  LedgerValidationOperation,
  LedgerValidationReason,
  LedgerTransferRecord,
}
