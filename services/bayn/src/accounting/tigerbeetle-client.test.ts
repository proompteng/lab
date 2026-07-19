import { describe, expect, test } from 'bun:test'
import { Effect, Either } from 'effect'
import { CreateAccountStatus, type Account } from 'tigerbeetle-node'

import { TigerBeetleCreateError, TigerBeetleRequestError } from './errors'
import { buildJournalPlan } from './plan'
import { evaluationFixture, FakeTigerBeetleClient } from './test-support'
import {
  makeTigerBeetleClientService,
  TIGERBEETLE_MAX_BATCH_SIZE,
  type TigerBeetleRawClient,
} from './tigerbeetle-client'

describe('Effect TigerBeetle client layer', () => {
  test('maps native request failures into typed failures', async () => {
    const rawClient = new FakeTigerBeetleClient()
    rawClient.lookupAccounts = async () => {
      throw new Error('replica unavailable')
    }
    const client = makeTigerBeetleClientService(rawClient)
    const result = await Effect.runPromise(client.lookupAccounts([1n]).pipe(Effect.either))

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(TigerBeetleRequestError)
      expect(result.left).toMatchObject({ operation: 'lookupAccounts', message: 'replica unavailable' })
    }
  })

  test('fails unexpected create statuses with the exact event index and ID', async () => {
    const plan = Effect.runSync(buildJournalPlan(evaluationFixture()))
    const candidate = plan.accounts[0]!.account
    const rawClient = new FakeTigerBeetleClient()
    rawClient.createAccounts = async () => [{ timestamp: 0n, status: CreateAccountStatus.ledger_must_not_be_zero }]
    const client = makeTigerBeetleClientService(rawClient)
    const result = await Effect.runPromise(client.ensureAccounts([candidate]).pipe(Effect.either))

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(TigerBeetleCreateError)
      expect(result.left).toMatchObject({ entity: 'account', index: 0, id: candidate.id })
    }
  })

  test('looks up an existing transfer and rejects changed economics', async () => {
    const plan = Effect.runSync(buildJournalPlan(evaluationFixture()))
    const rawClient = new FakeTigerBeetleClient()
    const client = makeTigerBeetleClientService(rawClient)
    await Effect.runPromise(client.ensureAccounts(plan.accounts.map(({ account }) => account)))
    const transfer = plan.transfers[0]!.transfer
    await Effect.runPromise(client.ensureTransfers([transfer]))

    const result = await Effect.runPromise(
      client.ensureTransfers([{ ...transfer, amount: transfer.amount + 1n }]).pipe(Effect.either),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toMatchObject({
        _tag: 'TigerBeetleDuplicateConflictError',
        entity: 'transfer',
        id: transfer.id,
        field: 'amount',
      })
    }
  })

  test('chunks native operations at the TigerBeetle protocol batch limit', async () => {
    const account = Effect.runSync(buildJournalPlan(evaluationFixture())).accounts[0]!.account
    let createBatchSizes: number[] = []
    let lookupBatchSizes: number[] = []
    const rawClient: TigerBeetleRawClient = {
      createAccounts: async (batch) => {
        createBatchSizes.push(batch.length)
        return batch.map((_, index) => ({ timestamp: BigInt(index + 1), status: CreateAccountStatus.created }))
      },
      createTransfers: async () => [],
      lookupAccounts: async (batch) => {
        lookupBatchSizes.push(batch.length)
        return []
      },
      lookupTransfers: async () => [],
      destroy: () => undefined,
    }
    const accounts: Account[] = Array.from({ length: TIGERBEETLE_MAX_BATCH_SIZE + 1 }, (_, index) => ({
      ...account,
      id: BigInt(index + 1),
    }))
    const client = makeTigerBeetleClientService(rawClient)

    const summary = await Effect.runPromise(client.ensureAccounts(accounts))
    await Effect.runPromise(client.lookupAccounts(accounts.map(({ id }) => id)))

    expect(summary).toEqual({ created: TIGERBEETLE_MAX_BATCH_SIZE + 1, existing: 0 })
    expect(createBatchSizes).toEqual([TIGERBEETLE_MAX_BATCH_SIZE, 1])
    expect(lookupBatchSizes).toEqual([TIGERBEETLE_MAX_BATCH_SIZE, 1])
  })
})
