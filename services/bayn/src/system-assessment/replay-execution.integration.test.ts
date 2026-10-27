import { ReplayImagePlatform } from './replay-image-platform'
import { JevResearchPolicy } from '../jev/acceptance'
import { expect, test } from 'bun:test'
import { gzipSync } from 'node:zlib'
import { NodeServices } from '@effect/platform-node'
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Result, Schema } from 'effect'

import { sha256 } from '../hash'
import { retainedReplayFixture } from '../testing/retained-replay-fixture'
import { nativeReplayPolicyManifest } from '../intraday-replay/native-policy'
import { loadActiveStrategyProtocol } from '../strategy'
import { testHash } from './fixtures.test-support'
import { completeLatencyArtifactFixture } from './latency-report.test-support'
import {
  fullBatchLatencyFixture,
  latencyCalibrationDecisionFixture,
  nativeLatencyBacktestFixture,
} from './latency.test-support'
import { bindLatencyStressSources, verifyLatencyStressImages } from './latency-report'
import { observeReplayExecution } from './replay-execution'
import { runReplayEvidenceCommand } from './replay-image'

const nativeTest = process.env['BAYN_TEST_REPLAY_EXECUTION'] === '1' ? test : test.skip

nativeTest.each([JevResearchPolicy.Candidate, JevResearchPolicy.Ablation, JevResearchPolicy.Momentum])(
  'a real stopped %s container binds its image, command and retained files to an observer receipt',
  async (policy) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: 'bayn-execution-observer-test-' })
        const command = (args: readonly string[]) =>
          runReplayEvidenceCommand('docker', args).pipe(Effect.map((bytes) => new TextDecoder().decode(bytes).trim()))
        const container = (args: readonly string[]) =>
          Effect.acquireRelease(command(args), (id) => command(['rm', '-f', id]).pipe(Effect.ignore))
        const registry = yield* container([
          'run',
          '-d',
          '--memory',
          '128m',
          '--tmpfs',
          '/var/lib/registry:rw,size=32m',
          '-p',
          '127.0.0.1::5000',
          process.env['BAYN_TEST_REGISTRY_IMAGE'] ?? 'registry:3.0.0',
        ])
        const address = yield* command(['port', registry, '5000/tcp'])
        const repository = `${address}/bayn-observer-test`
        const native = yield* latencyCalibrationDecisionFixture
        const calibration = fullBatchLatencyFixture(native.document, native.native)
        const initial = nativeLatencyBacktestFixture(calibration)
        const base = initial.registration.policies[0]
        if (base === undefined) throw new Error('Missing candidate fixture')
        const executable =
          '#!/bin/sh\nset -eu\nmkdir -p /result/run\ncp /evidence/fixture-report.json /result/run/report.json\ncp /evidence/fixture-passes.ndjson.gz /result/run/passes.ndjson.gz\n'
        const payload = `${root}/payload`
        yield* fs.makeDirectory(`${payload}/app/services/bayn/dist`, { recursive: true })
        yield* fs.makeDirectory(`${payload}/usr/local/bin`, { recursive: true })
        yield* fs.writeFileString(`${payload}/usr/local/bin/node`, '#!/bin/sh\nexec /bin/sh "$@"\n')
        yield* fs.chmod(`${payload}/usr/local/bin/node`, 0o755)
        yield* fs.writeFileString(`${payload}/app/services/bayn/dist/backtest-command.js`, executable)
        yield* fs.writeFileString(
          `${payload}/app/services/bayn/dist/jev-compiler-dependencies.json`,
          JSON.stringify({
            schemaVersion: 'bayn.jev-compiler-dependencies.v4',
            sourceRevision: base.sourceRevision,
            bunVersion: '1.4.2',
            files: { 'node_modules/observer-fixture/index.js': testHash('fixture dependency') },
            controlFiles: {},
            compilerFiles: {},
            nativeReplayPolicies: Result.getOrThrow(
              Result.flatMap(loadActiveStrategyProtocol(), nativeReplayPolicyManifest),
            ),
          }),
        )
        const builder = yield* container([
          'create',
          process.env['BAYN_TEST_REPLAY_BASE_IMAGE'] ?? 'alpine:3.22.1',
          '/bin/true',
        ])
        yield* command(['cp', `${payload}/.`, `${builder}:/`])
        const labels = {
          'org.opencontainers.image.source': 'https://github.com/proompteng/lab',
          'org.opencontainers.image.revision': base.sourceRevision,
          'proompteng.ai/bayn.strategy-behavior-hash': base.strategyHash,
          'proompteng.ai/bayn.strategy-parameter-hash': base.parametersHash,
          'proompteng.ai/bayn.strategy-protocol-hash': base.protocolHash,
        }
        const tag = `${repository}:fixture`
        const imageId = yield* Effect.acquireRelease(
          command([
            'commit',
            ...Object.entries(labels).flatMap(([key, value]) => ['--change', `LABEL ${key}=${value}`]),
            builder,
            tag,
          ]),
          (id) => command(['image', 'rm', '-f', id]).pipe(Effect.ignore),
        )
        yield* command(['image', 'save', '-o', `${root}/image.tar`, imageId])
        yield* fs.makeDirectory(`${root}/layout`)
        yield* runReplayEvidenceCommand('tar', ['-xf', `${root}/image.tar`, '-C', `${root}/layout`])
        yield* runReplayEvidenceCommand('crane', ['push', `${root}/layout`, tag])
        const imageDigest = new TextDecoder().decode(yield* runReplayEvidenceCommand('crane', ['digest', tag])).trim()
        const architecture = yield* command(['image', 'inspect', imageId, '--format', '{{.Architecture}}'])
        const imagePlatform = yield* Schema.decodeUnknownEffect(Schema.Enum(ReplayImagePlatform))(
          `linux/${architecture}`,
        )
        const fixture = nativeLatencyBacktestFixture(calibration, { imageRepository: repository, imageDigest }, policy)
        const artifacts = completeLatencyArtifactFixture(fixture, sha256(executable), imagePlatform)
        const passes = gzipSync('')
        const report = { ...artifacts.report, passLog: { file: 'passes.ndjson.gz', sha256: sha256(passes) } }
        const descriptor = {
          ...artifacts.descriptor,
          reportFileHash: artifacts.retain({ ...report, reportHash: testHash(report) }),
        }
        artifacts.sources.add(descriptor.reportFileHash)
        const evidence = `${root}/evidence`
        const output = `${root}/output`
        yield* fs.makeDirectory(evidence)
        yield* fs.makeDirectory(output)
        const write = (hash: string, path: string) => {
          const bytes = artifacts.artifacts.get(hash)
          if (bytes === undefined) throw new Error('Missing retained fixture artifact')
          return fs.writeFile(path, bytes)
        }
        yield* write(descriptor.inputFileHash, `${evidence}/input.json`)
        yield* write(descriptor.captureFileHash, `${evidence}/source-receipt.json`)
        yield* write(descriptor.reportFileHash, `${evidence}/fixture-report.json`)
        yield* fs.writeFile(`${evidence}/arrivals.ndjson.gz`, gzipSync(retainedReplayFixture().body))
        yield* fs.writeFile(`${evidence}/fixture-passes.ndjson.gz`, passes)
        const id = yield* container([
          'create',
          '--read-only',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges=true',
          '--restart',
          'no',
          '-v',
          `${evidence}:/evidence:ro`,
          '-v',
          `${output}:/result:rw`,
          '--entrypoint',
          'node',
          '-e',
          'BAYN_BACKTEST_POSTGRES_URL=postgresql://test:test@127.0.0.1/bayn_replay',
          '-e',
          'BAYN_BACKTEST_TIGERBEETLE_ADDRESS=127.0.0.1:3000',
          '-e',
          'BAYN_BACKTEST_TIGERBEETLE_CLUSTER_ID=42',
          '-e',
          'BAYN_BACKTEST_TIGERBEETLE_LEDGER=42',
          imageId,
          '/app/services/bayn/dist/backtest-command.js',
          '--input',
          '/evidence/input.json',
          '--arrivals',
          '/evidence/arrivals.ndjson.gz',
          '--source-receipt',
          '/evidence/source-receipt.json',
          '--source-receipt-sha256',
          descriptor.captureFileHash,
          '--output',
          '/result/run',
        ])
        yield* command(['start', '-a', id])
        const request = {
          registrationHash: testHash(fixture.registration),
          sourceCutHash: testHash(fixture.cut),
          containerId: id,
          imagePlatform,
        }
        const captureDirectories: string[] = []
        const observedFs = {
          ...fs,
          makeTempDirectoryScoped: (options?: Parameters<typeof fs.makeTempDirectoryScoped>[0]) =>
            fs.makeTempDirectoryScoped(options).pipe(
              Effect.tap((path) =>
                Effect.sync(() => {
                  captureDirectories.push(path)
                }),
              ),
            ),
        }
        const observe = (filesystem = observedFs) =>
          observeReplayExecution(request, fixture.registration, fixture.cut).pipe(
            Effect.provideService(FileSystem.FileSystem, filesystem),
          )
        const receipt = yield* observe()
        expect(receipt.containerId).toBe(id)
        expect(receipt.image.manifestDigest).toBe(imageId)
        expect(receipt.inputFileHash).toBe(descriptor.inputFileHash)
        expect(receipt.reportFileHash).toBe(descriptor.reportFileHash)
        expect(receipt.passLogFileHash).toBe(sha256(passes))
        expect(receipt.assurance).toBe('TRUSTED_CONTAINER_DAEMON_OBSERVATION')
        const receiptHash = testHash(receipt)
        const sources = [{ ...descriptor, executionReceiptHash: receiptHash }]
        const images = yield* verifyLatencyStressImages(sources, fixture.registration, artifacts.artifacts)
        const bind = (receipts = new Map([[receiptHash, receipt]])) =>
          bindLatencyStressSources(
            sources,
            fixture.registration,
            fixture.cut,
            artifacts.artifacts,
            artifacts.sources,
            images,
            receipts,
          )
        const bound = Result.getOrThrow(bind())[0]
        expect(bound?.executionReceiptHash).toBe(receiptHash)
        expect(bound?.economics?.sessions).toHaveLength(20)
        expect(bound?.economics?.sessions.every((session) => session.qualificationPnlMicros === '0')).toBe(true)
        expect(Result.getOrThrow(bind(new Map()))[0]?.economics).toBeNull()
        expect(
          Result.isFailure(bind(new Map([[receiptHash, { ...receipt, containerId: testHash('substitution') }]]))),
        ).toBe(true)
        yield* fs.writeFile(`${output}/run/passes.ndjson.gz`, gzipSync('changed'))
        expect(Exit.isFailure(yield* Effect.exit(observe()))).toBe(true)
        const entered = yield* Deferred.make<void>()
        const interrupted = yield* observe({
          ...observedFs,
          readFile: (path) =>
            path.endsWith('/input.json')
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
              : fs.readFile(path),
        }).pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(interrupted)
        const defect = yield* Effect.exit(
          observe({ ...observedFs, readFile: () => Effect.die('Synthetic capture read defect') }),
        )
        expect(Exit.isFailure(defect) && Cause.hasDies(defect.cause)).toBe(true)
        yield* fs.writeFileString(`${evidence}/input.json`, '{"private":"observer-test-secret","source":null}')
        const malformed = yield* Effect.exit(observe())
        expect(Exit.isFailure(malformed)).toBe(true)
        expect(JSON.stringify(malformed)).not.toContain('observer-test-secret')
        for (const path of captureDirectories) expect(yield* fs.exists(path)).toBe(false)
        expect(captureDirectories.filter((path) => path.includes('/bayn-replay-capture-'))).toHaveLength(5)
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    )
  },
  120000,
)
