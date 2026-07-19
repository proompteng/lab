import {
  CreateAccountStatus,
  CreateTransferStatus,
  type Account,
  type CreateAccountResult,
  type CreateTransferResult,
  type Transfer,
} from 'tigerbeetle-node'

import type { TigerBeetleRawClient } from './tigerbeetle-client'

const accountFields = [
  'id',
  'user_data_128',
  'user_data_64',
  'user_data_32',
  'reserved',
  'ledger',
  'code',
  'flags',
] as const satisfies readonly (keyof Account)[]

const transferFields = [
  'id',
  'debit_account_id',
  'credit_account_id',
  'amount',
  'pending_id',
  'user_data_128',
  'user_data_64',
  'user_data_32',
  'timeout',
  'ledger',
  'code',
  'flags',
] as const satisfies readonly (keyof Transfer)[]

export const evaluationFixture = () => ({
  schemaVersion: 'bayn.evaluation-economics.v1' as const,
  evaluationId: 'evaluation-2026-07-19-fixture',
  initialCash: 1_000_000_000n,
  cashEntries: [
    { eventId: 'cash-deposit-1', sequence: 0, direction: 'DEPOSIT' as const, amount: 100_000_000n },
    { eventId: 'cash-withdrawal-1', sequence: 5, direction: 'WITHDRAWAL' as const, amount: 50_000_000n },
  ],
  trades: [
    {
      eventId: 'trade-buy-spy-1',
      sequence: 1,
      symbol: 'SPY',
      side: 'BUY' as const,
      quantity: 200_000_000n,
      grossAmount: 600_000_000n,
    },
    {
      eventId: 'trade-sell-spy-1',
      sequence: 3,
      symbol: 'SPY',
      side: 'SELL' as const,
      quantity: 50_000_000n,
      grossAmount: 160_000_000n,
    },
  ],
  fees: [
    { eventId: 'fee-buy-spy-1', sequence: 2, amount: 1_000_000n, tradeEventId: 'trade-buy-spy-1' },
    { eventId: 'fee-sell-spy-1', sequence: 4, amount: 500_000n, tradeEventId: 'trade-sell-spy-1' },
  ],
  ending: {
    cash: 608_500_000n,
    totalFees: 1_500_000n,
    equity: 1_088_500_000n,
    positions: [{ symbol: 'SPY', quantity: 150_000_000n, marketValue: 480_000_000n }],
  },
})

const cloneAccount = (account: Account): Account => ({ ...account })
const cloneTransfer = (transfer: Transfer): Transfer => ({ ...transfer })

/** In-memory protocol-faithful fake used only by focused accounting tests. */
export class FakeTigerBeetleClient implements TigerBeetleRawClient {
  readonly accounts = new Map<bigint, Account>()
  readonly transfers = new Map<bigint, Transfer>()
  createAccountsCallCount = 0
  createTransfersCallCount = 0
  destroyed = false

  async createAccounts(batch: Account[]): Promise<CreateAccountResult[]> {
    this.createAccountsCallCount += 1
    return batch.map((candidate, index) => {
      const existing = this.accounts.get(candidate.id)
      if (existing !== undefined) {
        const exact = accountFields.every((field) => existing[field] === candidate[field])
        return {
          timestamp: existing.timestamp,
          status: exact ? CreateAccountStatus.exists : CreateAccountStatus.exists_with_different_code,
        }
      }
      const created = { ...candidate, timestamp: BigInt(index + 1) }
      this.accounts.set(created.id, created)
      return { timestamp: created.timestamp, status: CreateAccountStatus.created }
    })
  }

  async createTransfers(batch: Transfer[]): Promise<CreateTransferResult[]> {
    this.createTransfersCallCount += 1
    return batch.map((candidate, index) => {
      const existing = this.transfers.get(candidate.id)
      if (existing !== undefined) {
        const exact = transferFields.every((field) => existing[field] === candidate[field])
        return {
          timestamp: existing.timestamp,
          status: exact ? CreateTransferStatus.exists : CreateTransferStatus.exists_with_different_amount,
        }
      }
      const debit = this.accounts.get(candidate.debit_account_id)
      const credit = this.accounts.get(candidate.credit_account_id)
      if (debit === undefined) {
        return { timestamp: 0n, status: CreateTransferStatus.debit_account_not_found }
      }
      if (credit === undefined) {
        return { timestamp: 0n, status: CreateTransferStatus.credit_account_not_found }
      }
      const timestamp = BigInt(this.transfers.size + index + 100)
      const created = { ...candidate, timestamp }
      this.transfers.set(created.id, created)
      debit.debits_posted += candidate.amount
      credit.credits_posted += candidate.amount
      return { timestamp, status: CreateTransferStatus.created }
    })
  }

  async lookupAccounts(batch: bigint[]): Promise<Account[]> {
    return batch.flatMap((id) => {
      const account = this.accounts.get(id)
      return account === undefined ? [] : [cloneAccount(account)]
    })
  }

  async lookupTransfers(batch: bigint[]): Promise<Transfer[]> {
    return batch.flatMap((id) => {
      const transfer = this.transfers.get(id)
      return transfer === undefined ? [] : [cloneTransfer(transfer)]
    })
  }

  destroy(): void {
    this.destroyed = true
  }
}
