import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http2'
import { describe, expect, test } from 'bun:test'
import * as restate from '@restatedev/restate-sdk'
import { Clock, Config, Effect, Exit, Option, Redacted, Schedule } from 'effect'
import { acquireRestateHttp2Server } from './restate-http2-server'
import { awaitRestateInvocation, RestateSendStatus, sendRestateInvocation } from './restate-invocation-client'
import {
  approvePublicInformation,
  makePublicInformationServices,
  submitPublicInformationActivation,
} from './restate-public-information'
import { PublicInformationSource, type PublicInformationRun } from '../public-information'

const admin = Effect.runSync(Config.option(Config.String('BAYN_TEST_RESTATE_ADMIN_URL'))).pipe(Option.getOrUndefined)
const ingress = Effect.runSync(Config.option(Config.String('BAYN_TEST_RESTATE_INGRESS_URL'))).pipe(
  Option.getOrUndefined,
)
const describeRestate = admin === undefined || ingress === undefined ? describe.skip : describe

describeRestate('Real Restate independent public information jobs', () => {
  test('bootstrap waits for the matching registered revision before accepting either source activation', async () => {
    if (admin === undefined || ingress === undefined) throw new Error('Missing local Restate URLs')
    for (const target of [admin, ingress])
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(target).hostname))
        throw new Error('Local Restate is required')
    const revision = randomUUID().replaceAll('-', '').padEnd(40, 'a')
    const key = Redacted.make('b'.repeat(64))
    const config = { sourceRevision: revision, approvalKey: key, ingressOrigin: ingress }
    const register = (sourceRevision: string) =>
      Effect.gen(function* () {
        const services = makePublicInformationServices(
          { sourceRevision, approvalKey: key, intervalMs: () => 60_000 },
          {
            collect: async (source): Promise<PublicInformationRun> => ({
              schemaVersion: 'bayn.public-information-run.v1',
              source,
              sourceRevision,
              completedAt: '2026-10-14T00:00:00.000Z',
              symbols: [],
              issuerCiks: {},
              artifacts: [],
              missingIssuerSymbols: [],
              unavailableCompanyFacts: [],
              failures: [],
            }),
          },
        )
        const server = createServer(restate.createEndpointHandler({ services: [...services] }))
        yield* acquireRestateHttp2Server(server, 0)
        const address = server.address()
        if (address === null || typeof address === 'string') throw new Error('Missing local endpoint')
        yield* Effect.tryPromise({
          try: async (signal) => {
            const response = await fetch(`${admin}/deployments`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ uri: `http://host.docker.internal:${address.port}`, force: true }),
              signal,
            })
            if (!response.ok) throw new Error('Registration failed')
          },
          catch: (cause) => cause,
        })
      })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* register('c'.repeat(40))
          const incorrectlyAccepted = yield* sendRestateInvocation(
            `${ingress}/BaynPublicInformationControl/activate/send`,
            {
              source: PublicInformationSource.Macro,
              sourceRevision: revision,
              approval: approvePublicInformation(PublicInformationSource.Macro, revision, key),
            },
            { timeoutMs: 5000 },
          )
          expect(incorrectlyAccepted.status).toBe(RestateSendStatus.Accepted)
          const rejected = yield* awaitRestateInvocation(ingress, incorrectlyAccepted.invocationId, {
            maximumAttempts: 5,
            pollIntervalMs: 50,
            requestTimeoutMs: 1000,
          }).pipe(Effect.flip)
          expect(rejected.cause).toMatchObject({ message: 'Restate invocation output returned HTTP 500' })
          expect(
            Exit.isFailure(
              yield* submitPublicInformationActivation(config, PublicInformationSource.Macro).pipe(Effect.exit),
            ),
          ).toBe(true)
          yield* register(revision)
          for (const source of Object.values(PublicInformationSource)) {
            expect(yield* submitPublicInformationActivation(config, source)).toMatchObject({ status: 'Accepted' })
            yield* Effect.tryPromise({
              try: async (signal) => {
                const response = await fetch(`${ingress}/BaynPublicInformationControl/status`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify(source),
                  signal,
                })
                const value: unknown = await response.json()
                expect(value).toMatchObject({ sourceRevision: revision })
              },
              catch: (cause) => cause,
            }).pipe(Effect.retry({ schedule: Schedule.spaced('50 millis'), times: 100 }))
          }
        }),
      ),
    )
  }, 20_000)
  test('activation and unrelated execution finish while a source is blocked; failure preserves both loops', async () => {
    if (admin === undefined || ingress === undefined) throw new Error('Missing local Restate URLs')
    for (const target of [admin, ingress])
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(target).hostname))
        throw new Error('Local Restate is required')
    const revision = randomUUID().replaceAll('-', '').padEnd(40, 'a')
    const key = Redacted.make('b'.repeat(64))
    const blocked = Promise.withResolvers<PublicInformationRun>()
    let filingsStarted = false
    const result = (source: PublicInformationSource): PublicInformationRun => ({
      schemaVersion: 'bayn.public-information-run.v1',
      source,
      sourceRevision: revision,
      completedAt: '2026-10-14T00:00:00.000Z',
      symbols: [],
      issuerCiks: {},
      artifacts: [],
      missingIssuerSymbols: [],
      unavailableCompanyFacts: [],
      failures: [],
    })
    const services = makePublicInformationServices(
      { sourceRevision: revision, approvalKey: key, intervalMs: () => 60_000 },
      {
        collect: async (source) => {
          if (source === PublicInformationSource.Filings) {
            filingsStarted = true
            return blocked.promise
          }
          return result(source)
        },
      },
    )
    const probe = restate.service({
      name: 'IndependentExecutionProbe',
      handlers: { run: async () => ({ progressed: true }) },
    })
    const request = (path: string, body: unknown) =>
      Effect.tryPromise({
        try: async (signal) => {
          const response = await fetch(`${ingress}/${path}`, {
            method: 'POST',
            body: JSON.stringify(body),
            headers: { 'content-type': 'application/json' },
            signal,
          })
          if (!response.ok) throw new Error(`Local request failed ${response.status}`)
          return response.json()
        },
        catch: (cause) => cause,
      })
    const status = (source: PublicInformationSource) => request('BaynPublicInformationControl/status', source)
    const waitFor = (check: () => Effect.Effect<boolean, unknown>) =>
      Effect.suspend(check).pipe(
        Effect.flatMap((ready) => (ready ? Effect.void : Effect.fail('not ready'))),
        Effect.retry({ schedule: Schedule.spaced('50 millis'), times: 100 }),
      )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const startedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
          const server = createServer(restate.createEndpointHandler({ services: [...services, probe] }))
          yield* acquireRestateHttp2Server(server, 0)
          const address = server.address()
          if (address === null || typeof address === 'string') throw new Error('Missing local endpoint')
          yield* Effect.tryPromise({
            try: async (signal) => {
              const response = await fetch(`${admin}/deployments`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ uri: `http://host.docker.internal:${address.port}`, force: true }),
                signal,
              })
              if (!response.ok) throw new Error('Registration failed')
            },
            catch: (cause) => cause,
          })
          const previousFilings = yield* status(PublicInformationSource.Filings)
          const retainedFilingsRun =
            typeof previousFilings === 'object' && previousFilings !== null && 'lastRun' in previousFilings
              ? previousFilings.lastRun
              : null
          for (const source of Object.values(PublicInformationSource)) {
            expect(
              yield* request('BaynPublicInformationControl/activate', {
                source,
                sourceRevision: revision,
                approval: approvePublicInformation(source, revision, key),
              }),
            ).toMatchObject({ sequence: 1, sourceRevision: revision })
          }
          yield* waitFor(() => Effect.succeed(filingsStarted))
          expect(yield* request('IndependentExecutionProbe/run', {})).toEqual({ progressed: true })
          yield* waitFor(() =>
            status(PublicInformationSource.Macro).pipe(
              Effect.map(
                (value) => typeof value === 'object' && value !== null && 'lastRun' in value && value.lastRun !== null,
              ),
            ),
          )
          expect(yield* status(PublicInformationSource.Filings)).toMatchObject({ lastRun: retainedFilingsRun })
          blocked.reject(new Error('injected public upload failure'))
          yield* waitFor(() =>
            status(PublicInformationSource.Filings).pipe(
              Effect.map(
                (value) =>
                  typeof value === 'object' &&
                  value !== null &&
                  'lastFailureAt' in value &&
                  value.lastFailureAt !== null,
              ),
            ),
          )
          expect(yield* status(PublicInformationSource.Filings)).toMatchObject({
            sequence: 2,
            lastRun: retainedFilingsRun,
          })
          expect(yield* status(PublicInformationSource.Macro)).toMatchObject({ sequence: 2, lastFailureAt: null })
          expect(yield* request('IndependentExecutionProbe/run', {})).toEqual({ progressed: true })
          const privateResponse = yield* Effect.promise(() =>
            fetch(`${ingress}/BaynPublicInformation/SEC_FILINGS/poll`, {
              method: 'POST',
              body: '{}',
              headers: { 'content-type': 'application/json' },
            }),
          )
          expect(privateResponse.status).toBe(400)
          const queued = yield* Effect.tryPromise({
            try: async (signal) => {
              const response = await fetch(`${admin}/query`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify({
                  query: `SELECT COUNT(*) AS queued FROM sys_invocation WHERE target_service_name = 'BaynPublicInformation' AND target_handler_name = 'poll' AND status = 'scheduled' AND created_at >= '${startedAt}'`,
                }),
                signal,
              })
              return response.json()
            },
            catch: (cause) => cause,
          })
          expect(queued).toEqual({ rows: [{ queued: 2 }] })
        }),
      ),
    )
  }, 20_000)
})
