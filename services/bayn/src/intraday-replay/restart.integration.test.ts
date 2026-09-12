import { randomUUID } from 'node:crypto'
import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Schema } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import { baynTestPostgresUrl, baynTestTigerBeetleAddress } from '../test-environment.test-support'
import { canonicalHashV1 } from '../hash'
import { ReplayBrokerFailure } from './broker'
import { ReplayBrokerCheckpointSchema } from './broker-checkpoint'

const durableTest = baynTestPostgresUrl === undefined || baynTestTigerBeetleAddress === undefined ? test.skip : test

durableTest(
  'full process death after broker fill recovers from atomic PostgreSQL checkpoint without an export file or duplicate',
  async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const directory = yield* fs.makeTempDirectoryScoped()
        const checkpointPath = `${directory}/checkpoint.json`,
          resultPath = `${directory}/result.json`
        const runId = canonicalHashV1({ attempt: randomUUID() })
        const command = (mode: string) =>
          ChildProcess.make(
            process.execPath,
            [`${import.meta.dir}/restart-worker.test-support.ts`, mode, runId, checkpointPath, resultPath],
            { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', killSignal: 'SIGKILL' },
          )
        const first = yield* spawner.spawn(command('crash'))
        while (!(yield* fs.exists(checkpointPath))) {
          if (!(yield* first.isRunning))
            return yield* new ReplayBrokerFailure({ message: 'Crash worker exited before checkpoint' })
          yield* Effect.sleep('25 millis')
        }
        const checkpoint = yield* fs
          .readFileString(checkpointPath)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ReplayBrokerCheckpointSchema))))
        expect(checkpoint.state.fills).toHaveLength(1)
        // The export is only a test barrier. Recovery must survive its complete loss after the atomic database commit.
        yield* fs.remove(checkpointPath)
        expect(yield* fs.exists(checkpointPath)).toBe(false)
        yield* first.kill({ killSignal: 'SIGKILL' })
        yield* Effect.exit(first.exitCode)
        const second = yield* spawner.spawn(command('recover'))
        expect(second.pid).not.toBe(first.pid)
        expect(Number(yield* second.exitCode)).toBe(0)
        const result = yield* fs.readFileString(resultPath).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.fromJsonString(
                Schema.Struct({
                  state: Schema.Struct({
                    fills: Schema.Array(Schema.Unknown),
                    ledger: Schema.Struct({ cashMicros: Schema.String }),
                  }),
                  counts: Schema.Array(
                    Schema.Struct({ intents: Schema.Number, fills: Schema.Number, transactions: Schema.Number }),
                  ),
                  reconciliation: Schema.Struct({
                    report: Schema.Struct({
                      metrics: Schema.Struct({ accountingExact: Schema.Boolean }),
                      reconciliation: Schema.Struct({ status: Schema.String }),
                    }),
                    brokerState: Schema.Struct({
                      unknownOrderCount: Schema.Number,
                      account: Schema.Struct({ cashMicros: Schema.String }),
                    }),
                    riskContext: Schema.Struct({ unknownMutationCount: Schema.Number }),
                  }),
                }),
              ),
            ),
          ),
        )
        expect(result.state.fills).toEqual(checkpoint.state.fills)
        expect(result.counts).toEqual([{ intents: 1, fills: 1, transactions: 1 }])
        expect(result.reconciliation.report.metrics.accountingExact).toBe(true)
        expect(result.reconciliation.report.reconciliation.status).toBe('EXACT')
        expect(result.reconciliation.brokerState.unknownOrderCount).toBe(0)
        expect(result.reconciliation.riskContext.unknownMutationCount).toBe(0)
        expect(result.reconciliation.brokerState.account.cashMicros).toBe(checkpoint.state.ledger.cashMicros)
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.timeout('25 seconds')),
    )
  },
  30000,
)
