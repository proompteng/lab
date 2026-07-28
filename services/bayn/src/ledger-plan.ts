import { Result } from 'effect'

import { planDecodedLedgerInput } from './ledger-plan/build'
import { hashLedgerPlanResult } from './ledger-plan/hash'
import { decodeLedgerInput } from './ledger-plan/input'
import {
  AccountCode,
  failLedgerValidation,
  ledgerValidationError,
  LEDGER_BATCH_MAX,
  LEDGER_SCHEMA_VERSION,
  LedgerValidationError,
  makeLedgerPlanFailure,
  renderLedgerPlanFailure,
  TransferCode,
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

export const buildLedgerPlan = (
  input: unknown,
  ledger: number,
): Result.Result<EvaluationLedgerPlan, LedgerPlanFailure> =>
  Result.mapError(
    Result.flatMap(decodeLedgerInput(input), (decoded) => planDecodedLedgerInput(decoded, ledger)),
    (failure) => makeLedgerPlanFailure(ledger, failure),
  )

export {
  AccountCode,
  accountMetadataMatches,
  failLedgerValidation,
  hashLedgerPlanResult,
  ledgerValidationError,
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
  LedgerPlan,
  LedgerPlanAmountField,
  LedgerPlanFailure,
  LedgerPlanFailureDetail,
  LedgerPlanHashFailure,
  LedgerPlanInputField,
  LedgerValidationOperation,
  LedgerValidationReason,
}
