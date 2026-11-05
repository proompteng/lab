import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Schema } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

import { sha256 } from '../hash'
import { JevResearchPolicy } from '../jev/acceptance'
import { baynTestPostgresUrl, baynTestTigerBeetleAddress } from '../test-environment.test-support'
import { withLatencyCliPhase } from './latency-cli-progress.test-support'
import { writeCompiledReplayCommand } from './replay-cli.test-support'

const durableTest = baynTestPostgresUrl === undefined || baynTestTigerBeetleAddress === undefined ? test.skip : test

export const latencyCliAcceptance = (policy: JevResearchPolicy, trading: boolean) =>
  durableTest(
    `native ${policy} latency CLI retains twenty sessions with trading=${trading}`,
    async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const directory = yield* fs.makeTempDirectoryScoped({
            directory: `${import.meta.dir}/../../node_modules`,
            prefix: '.latency-cli-test-',
          })
          const executablePath = `${directory}/backtest-command.js`
          const workerPath = `${directory}/latency-cli.js`
          yield* Effect.gen(function* () {
            yield* writeCompiledReplayCommand(executablePath, `${import.meta.dir}/replay-phase-command.test-support.ts`)
            yield* writeCompiledReplayCommand(workerPath, `${import.meta.dir}/latency-cli.test-support.ts`)
          }).pipe(withLatencyCliPhase('compile'))
          const node = Bun.which('node')
          if (node === null) throw new Error('Compiled replay acceptance requires the pinned Node runtime')
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const child = yield* spawner.spawn(
            ChildProcess.make(node, [workerPath, policy, trading ? 'trading' : 'missing', directory, executablePath], {
              stdin: 'ignore',
              stdout: 'inherit',
              stderr: 'inherit',
            }),
          )
          yield* child.exitCode.pipe(
            Effect.tap((code) => Effect.sync(() => expect(Number(code)).toBe(0))),
            withLatencyCliPhase('worker'),
          )
          const result = yield* fs.readFileString(`${directory}/acceptance.json`).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.fromJsonString(
                  Schema.Struct({
                    policy: Schema.String,
                    trading: Schema.Boolean,
                    sessionCount: Schema.Number,
                    filledSessions: Schema.Number,
                    executionProfitMicros: Schema.String,
                    qualificationProfitMicros: Schema.String,
                    complete: Schema.Boolean,
                    providerDispatchCount: Schema.Number,
                    receiptEconomicsComplete: Schema.Boolean,
                    executableHash: Schema.String,
                  }),
                ),
              ),
            ),
          )
          expect(result).toMatchObject({
            policy,
            trading,
            sessionCount: 20,
            filledSessions: trading ? 20 : 0,
            complete: true,
            providerDispatchCount: 0,
            receiptEconomicsComplete: false,
            executableHash: sha256(yield* fs.readFile(executablePath)),
          })
          expect(BigInt(result.qualificationProfitMicros)).toBe(BigInt(result.executionProfitMicros) - 20_000_000n)
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      )
    },
    600000,
  )
