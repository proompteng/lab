import { Data, Result } from 'effect'

export type AccountingValidationOperation =
  | 'build-account-reconciliation'
  | 'build-plan'
  | 'check-run'
  | 'preflight-transfers'

export type AccountingValidationReason =
  | 'empty-plan'
  | 'invalid-roundDiv'
  | 'invalid-amounts'
  | 'invalid-calculateAmounts'
  | 'invalid-preparedAccounting'
  | 'invalid-rebuildAccountingLedger'

export class AccountingValidationError extends Data.TaggedError('AccountingValidationError')<{
  readonly operation: AccountingValidationOperation
  readonly reason: AccountingValidationReason
  readonly message: string
  readonly material: Readonly<Record<string, unknown>>
  readonly cause?: unknown
}> {}

export const accountingValidationError = (
  operation: AccountingValidationOperation,
  reason: AccountingValidationReason,
  message: string,
  material: Readonly<Record<string, unknown>>,
  cause?: unknown,
): AccountingValidationError => new AccountingValidationError({ operation, reason, message, material, cause })

export const failAccountingValidation = (
  operation: AccountingValidationOperation,
  reason: AccountingValidationReason,
  detail: string,
  material: Readonly<Record<string, unknown>>,
  cause?: unknown,
): Result.Result<never, AccountingValidationError> =>
  Result.fail(accountingValidationError(operation, reason, detail, material, cause))

export const validationBoundary = <A>(
  decision: Result.Result<A, AccountingValidationError>,
): Result.Result<A, AccountingValidationError> => decision
