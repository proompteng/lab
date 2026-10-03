import { expect, test } from 'bun:test'
import type { ObjectContext, ObjectSharedContext } from '@restatedev/restate-sdk'
import { Clock, Effect, Logger, Redacted, References, Result } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { TestClock } from 'effect/testing'

import { canonicalHashV1 } from '../../hash'
import { currentUtcInstant } from '../../time'
import { makeBaynBrokerObservations } from '../../restate/restate-broker-observations'
import {
  executionActivationAuthorizationHash,
  makeBaynExecutionController,
} from '../../restate/restate-execution-controller'
import { alpacaSandboxBaseUrl, decodeBrokerConnection } from '../connection'
import { BrokerEnvironment, BrokerProvider } from '../identity'
import { make } from './http'
import { captureBrokerObservation } from './snapshot-cache'

test('normal broker polling emits diagnostics while native deployment activation remains blocked, without order mutations', async () => {
  const accountId = 'e6fe16f3-64a4-4921-8928-cadf02f92f98'
  const sourceRevision = 'b'.repeat(40)
  const controllerKey = 'c'.repeat(64)
  const planHash = 'd'.repeat(64)
  const token = Buffer.alloc(32, 7).toString('base64url')
  const connection = Result.getOrThrow(
    decodeBrokerConnection({
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      baseUrl: alpacaSandboxBaseUrl,
      expectedAccountId: accountId,
      key: Redacted.make('synthetic-key'),
      secret: Redacted.make('synthetic-secret'),
      proxyUrl: 'http://bayn-egress-proxy:3128',
      operationTimeoutMs: 30_000,
      retryAttempts: 0,
    }),
  )
  const requests: Array<{ method: string; path: string }> = []
  const diagnostics: unknown[] = []
  let advances = 0
  const logger = Logger.make<unknown, void>((entry) => {
    const value = entry.fiber.getRef(References.CurrentLogAnnotations)['brokerReadDiagnostic']
    if (value !== undefined) diagnostics.push(value)
  })
  const client = HttpClient.make((request, url) => {
    requests.push({ method: request.method, path: url.pathname })
    const body =
      url.pathname === '/v2/account'
        ? {
            id: accountId,
            account_number: 'private',
            status: 'ACTIVE',
            currency: 'USD',
            cash: '100',
            equity: '100',
            last_equity: '100',
            buying_power: '100',
            account_blocked: false,
            trading_blocked: false,
            trade_suspended_by_user: false,
            accrued_fees: '0',
            pending_reg_taf_fees: '0.01',
          }
        : url.pathname === '/v2/account/activities/FEE'
          ? [
              {
                activity_type: 'FEE',
                id: '20260910000000000::61e69015-8549-4bfd-b9c3-01e75843f47d',
                date: '2026-09-10',
                net_amount: '-0.01',
                status: 'executed',
                description: 'TAF fee for a synthetic trade by private',
              },
            ]
          : url.pathname === '/v2/account/configurations'
            ? { fractional_trading: true }
            : []
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          headers: { 'content-type': 'application/json', 'x-request-id': `request-${requests.length}` },
        }),
      ),
    )
  })
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.adjust(Date.parse('2026-09-11T08:00:00.000Z'))
      const execute = Effect.runPromiseWith(yield* Effect.context<never>())
      const read = yield* make(connection)
      const durable = new Map<string, unknown>()
      const ticks: Array<{ parameter: unknown }> = []
      const observation = makeBaynBrokerObservations(
        { controllerKey, sourceRevision, pollIntervalMs: 10_000, operationTimeoutMs: 30_000 },
        {
          activate: async () => undefined,
          preparePoll: async () => 'synthetic-capture',
          nextPollNotBeforeMs: async () => 0,
          poll: (signal) =>
            execute(
              Effect.gen(function* () {
                const snapshot = yield* captureBrokerObservation(read, yield* currentUtcInstant, 30_000)
                return { _tag: 'Published', snapshotHash: canonicalHashV1(snapshot), nextPollNotBeforeMs: 0 } as const
              }),
              { signal },
            ),
        },
      )
      const observationContext = {
        key: controllerKey,
        get: async (key: string) => durable.get(key) ?? null,
        set: (key: string, value: unknown) => {
          durable.set(key, value)
        },
        date: { now: () => execute(Clock.currentTimeMillis) },
        request: () => ({ attemptCompletedSignal: new AbortController().signal }),
        run: async (_name: string, action: () => Promise<unknown>) => action(),
        genericSend: (delivery: { parameter: unknown }) => {
          ticks.push(delivery)
        },
        console: { warn: () => undefined },
      } as unknown as ObjectContext
      const owner = (
        observation as unknown as {
          object: {
            activate: (ctx: ObjectContext, input: unknown) => Promise<unknown>
            poll: (ctx: ObjectContext, input: unknown) => Promise<void>
          }
        }
      ).object
      const pollNext = async () => {
        const next = ticks.shift()
        if (next === undefined) throw new Error('missing ordinary observer tick')
        await owner.poll(observationContext, next.parameter)
      }
      const controller = makeBaynExecutionController(
        {
          controllerKey,
          sourceRevision,
          planHash,
          operationTimeoutMs: 30_000,
          activationAuthorizationHash: Result.getOrThrow(executionActivationAuthorizationHash(token)),
        },
        {
          advance: () => {
            advances += 1
            return Promise.reject(new Error('execution must remain blocked'))
          },
          log: async () => undefined,
          projectState: async () => undefined,
        },
      )
      const execution = (
        controller as unknown as {
          object: {
            activateDeployment: (ctx: ObjectSharedContext, input: unknown) => Promise<unknown>
          }
        }
      ).object
      let executionActivated = false
      const waitingState = {
        schemaVersion: 1,
        active: true,
        epoch: 1,
        planHash,
        sourceRevision,
        initialSequence: 1,
        nextSequence: 1,
      }
      const context = {
        key: controllerKey,
        request: () => ({
          id: 'blocked-activation',
          headers: new Map([['authorization', `Bearer ${token}`]]),
          attemptCompletedSignal: new AbortController().signal,
        }),
        objectClient: () => ({
          status: async () => (executionActivated ? waitingState : null),
          activate: async () => {
            executionActivated = true
            return waitingState
          },
        }),
        genericCall: async (command: { service: string; method: string; parameter: unknown }) => {
          expect(command.service).toBe('BaynBrokerObservations')
          expect(command.method).toBe('activate')
          return owner.activate(observationContext, command.parameter)
        },
        sleep: async () => {
          await execute(TestClock.adjust(60_000))
          await pollNext()
          throw new Error('synthetic activation remains blocked on its successor pass')
        },
      } as unknown as ObjectSharedContext
      const blocked = yield* Effect.promise(() =>
        execution
          .activateDeployment(context, {
            schemaVersion: 'bayn.execution-deployment-activation.v1',
            controllerKey,
            planHash,
            sourceRevision,
          })
          .then(
            () => 'unexpected completion',
            (error: unknown) => String(error),
          ),
      )
      expect(blocked).toContain('synthetic activation remains blocked')
      expect(diagnostics).toHaveLength(1)
      expect(executionActivated).toBe(true)
      expect(advances).toBe(0)
      const initialRequests = requests.length
      yield* TestClock.adjust(60_000)
      yield* Effect.promise(pollNext)
      expect(requests.length).toBeGreaterThan(initialRequests)
      expect(diagnostics).toHaveLength(1)
      expect(ticks).toHaveLength(1)
      expect(requests.every((request) => request.method === 'GET')).toBe(true)
      expect(requests.filter((request) => request.path === '/v2/account')).toHaveLength(3)
      expect(requests.filter((request) => request.path === '/v2/account/activities/FEE')).toHaveLength(6)
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provide(TestClock.layer()),
      Effect.provide(Logger.layer([logger])),
    ),
  )
})
