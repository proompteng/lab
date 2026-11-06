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
const config = {
  operationTimeoutMs: 1000,
  postgres: { url: Redacted.make('postgresql://test:test@127.0.0.1:55432/bayn_replay'), tls: false, caPath: '/unused' },
  tigerBeetle: { clusterId: 20912n, ledger: 70912, replicaAddresses: ['127.0.0.1:53000'] },
}

test('candidate and ablation acquire only the existing Jev credential', async () => {
  const environment = ConfigProvider.fromUnknown({ BAYN_JEV_API_KEY: 'synthetic-never-dispatched-key' })
  const transport = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die('This test must not dispatch a provider request')),
  )
  for (const policy of [JevResearchPolicy.Ablation, JevResearchPolicy.Candidate] as const) {
    const acquired = await Effect.runPromise(
      JevClient.pipe(
        Effect.provide(measuredReplayProviderLayer(policy, 1000).pipe(Layer.provide(transport))),
        Effect.provideService(ConfigProvider.ConfigProvider, environment),
      ),
    )
    expect(typeof acquired.evaluate).toBe('function')
  }
  const missing = await Effect.runPromiseExit(
    JevClient.pipe(
      Effect.provide(measuredReplayProviderLayer(JevResearchPolicy.Candidate, 1000).pipe(Layer.provide(transport))),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
    ),
  )
  expect(missing._tag).toBe('Failure')
})
test('momentum acquires no provider credential and rejects all inference', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* JevClient).evaluate({}, 1000).pipe(Effect.result)
    }).pipe(
      Effect.provide(
        measuredReplayProviderLayer(JevResearchPolicy.Momentum, 1000).pipe(
          Layer.provide(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die('Momentum cannot dispatch HTTP')),
            ),
          ),
        ),
      ),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
    ),
  )
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) expect(result.failure.message).toContain('forbidden by the momentum policy')
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
