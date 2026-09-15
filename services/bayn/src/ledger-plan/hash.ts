import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import type { LedgerAccountRecord, LedgerPlan, LedgerPlanHashFailure, LedgerTransferRecord } from './model'

const serializeRecord = (record: LedgerAccountRecord | LedgerTransferRecord): Record<string, number | string> =>
  Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, typeof value === 'bigint' ? value.toString() : value]),
  )

export const hashLedgerPlanResult = (plan: LedgerPlan): Result.Result<string, LedgerPlanHashFailure> =>
  Result.mapError(
    canonicalHashV1Result({
      schemaVersion: 'bayn.ledger-plan.v1',
      runKey: plan.runKey.toString(),
      runTag: plan.runTag.toString(),
      accounts: plan.accounts.map(serializeRecord),
      transfers: plan.transfers.map(serializeRecord),
    }),
    (cause): LedgerPlanHashFailure => ({ _tag: 'LedgerPlanHashCanonicalizationFailed', cause }),
  )
