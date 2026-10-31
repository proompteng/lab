import { validateReplayDatabaseTargets } from './intraday-replay/database-targets'
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { NodeServices } from '@effect/platform-node'
import { ConfigProvider, Effect, FileSystem, Layer, Redacted, Result } from 'effect'
import { HttpClient } from 'effect/http'
import {
  compressBacktestPass,
  hashBacktestPassLog,
  parseBacktestArgs,
  measuredReplayProviderLayer,
} from './backtest-command'
import { JevResearchPolicy } from './jev/acceptance'
import { JevClient } from './jev/client'
import { DecisionsClient } from './jev/decisions'
const config = {
  operationTimeoutMs: 1000,
  postgres: { url: Redacted.make('postgresql://test:test@127.0.0.1:55432/bayn_replay'), tls: false, caPath: '/unused' },
  tigerBeetle: { clusterId: 20912n, ledger: 70912, replicaAddresses: ['127.0.0.1:53000'] },
}

test('measured ablation acquires only chart credentials and rejects any Jev dispatch', async () => {
  const environment = ConfigProvider.fromUnknown({
    BAYN_OPENAI_API_KEY: 'synthetic-never-dispatched-key',
    BAYN_PUBLIC_INFORMATION_PROXY: 'http://127.0.0.1:9',
  })
  const transport = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die('This test must not dispatch a provider request')),
  )
  const acquired = await Effect.runPromise(
    Effect.gen(function* () {
      const chart = yield* DecisionsClient
      const jev = yield* JevClient
      expect(typeof chart.evaluate).toBe('function')
      return yield* Effect.result(jev.evaluate({}, 1000))
    }).pipe(
      Effect.provide(measuredReplayProviderLayer(JevResearchPolicy.Ablation, 1000).pipe(Layer.provide(transport))),
      Effect.provideService(ConfigProvider.ConfigProvider, environment),
    ),
  )
  expect(Result.isFailure(acquired)).toBe(true)
  if (Result.isFailure(acquired)) expect(acquired.failure.message).toContain('forbidden by the ablation policy')
  const candidate = await Effect.runPromiseExit(
    DecisionsClient.pipe(
      Effect.provide(measuredReplayProviderLayer(JevResearchPolicy.Candidate, 1000).pipe(Layer.provide(transport))),
      Effect.provideService(ConfigProvider.ConfigProvider, environment),
    ),
  )
  expect(candidate._tag).toBe('Failure')
})
test('momentum acquires neither provider credentials nor network transport and rejects both dispatches', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const jev = yield* JevClient
      const chart = yield* DecisionsClient
      const jevResult = yield* Effect.result(jev.evaluate({}, 1000))
      const chartResult = yield* Effect.result(chart.evaluate({}, 1000))
      for (const result of [jevResult, chartResult]) {
        expect(result._tag).toBe('Failure')
        if (result._tag === 'Failure') expect(result.failure.message).toContain('forbidden by the momentum policy')
      }
    }).pipe(
      Effect.provide(
        measuredReplayProviderLayer(JevResearchPolicy.Momentum, 1000).pipe(
          Layer.provide(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die('Momentum cannot dispatch transport')),
            ),
          ),
        ),
      ),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
    ),
  )
})

test('concatenated compressed passes reproduce every original JSON byte and record boundary', async () => {
  const lines = [
    JSON.stringify({ state: 'é'.repeat(65537), fills: ['a', 'b'] }),
    JSON.stringify({ state: 'next', fills: [] }),
  ]
  const bytes = await Effect.runPromise(Effect.forEach(lines, compressBacktestPass))
  expect(gunzipSync(Buffer.concat(bytes)).toString('utf8')).toBe(lines.join('\n') + '\n')
})
test('pass-log hash preserves exact UTF-8 bytes across stream chunks', async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped()
        const path = `${directory}/passes.ndjson`
        const text = `${'x'.repeat(65535)}é\n${'y'.repeat(131073)}\n`
        yield* fs.writeFileString(path, text)
        expect(yield* hashBacktestPassLog(path)).toBe(createHash('sha256').update(text).digest('hex'))
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  )
})
test('pass-log read failure cannot produce a successful digest', async () => {
  const result = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped()
        return yield* hashBacktestPassLog(`${directory}/missing.ndjson`)
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  )
  expect(result._tag).toBe('Failure')
})
test('session command requires source, input and a separate output directory', () => {
  expect(parseBacktestArgs(['--help'])._tag).toBe('Help')
  expect(
    parseBacktestArgs([
      '--input',
      'input.json',
      '--arrivals',
      'raw.ndjson',
      '--source-receipt',
      'capture.json',
      '--source-receipt-sha256',
      'a'.repeat(64),
      '--output',
      'result',
    ]),
  ).toMatchObject({ _tag: 'Run' })
  expect(parseBacktestArgs(['--input', 'input.json'])._tag).toBe('Invalid')
  expect(parseBacktestArgs(['--input', 'input.json', '--arrivals', 'raw.ndjson', '--output', 'result'])._tag).toBe(
    'Invalid',
  )
})
test('session command cannot target live database hosts or unspecified database names', async () => {
  expect((await Effect.runPromiseExit(validateReplayDatabaseTargets(config)))._tag).toBe('Success')
  for (const url of [
    'postgresql://test:test@bayn-rw.bayn.svc:5432/bayn_replay',
    'postgresql://test:test@127.0.0.1:55432/bayn',
    'https://localhost/bayn_replay',
    'postgresql://test:test@localhost/bayn_replay?host=bayn-rw.bayn.svc&database=bayn',
    'postgresql://test:test@localhost/bayn_replay?database=bayn',
    'postgresql://test:test@localhost/bayn_replay?options=-csearch_path%3Dpublic',
    'postgresql://test:test@localhost/bayn_replay#unvalidated-fragment',
  ])
    expect(
      (
        await Effect.runPromiseExit(
          validateReplayDatabaseTargets({ ...config, postgres: { ...config.postgres, url: Redacted.make(url) } }),
        )
      )._tag,
    ).toBe('Failure')
  expect(
    (
      await Effect.runPromiseExit(
        validateReplayDatabaseTargets({
          ...config,
          tigerBeetle: { ...config.tigerBeetle, replicaAddresses: ['tigerbeetle.bayn.svc:3000'] },
        }),
      )
    )._tag,
  ).toBe('Failure')
})
