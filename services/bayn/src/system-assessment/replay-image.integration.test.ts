import { ReplayImagePlatform } from './replay-image-platform'
import { expect, test } from 'bun:test'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import { NodeHttpServer, NodeServices } from '@effect/platform-node'
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Result } from 'effect'
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { TestClock } from 'effect/testing'

import { sha256 } from '../hash'
import { nativeReplayPolicyManifest } from '../intraday-replay/native-policy'
import { loadActiveStrategyProtocol } from '../strategy'
import { testHash } from './fixtures.test-support'
import {
  bindReplayImagePolicy,
  bindFrozenReplayImagePolicy,
  VerifiedReplayImage,
  verifiedManifestBytes,
} from './replay-image'
import { frozenControlOrigin, frozenDeployedControlIdentity } from './frozen-control-identity'
import { JevResearchPolicy } from '../jev/acceptance'
import { JevCompilerDependencyReceiptSchema } from '../jev/instruction-variant'
import { Schema } from 'effect'
import { registrationFixture } from './fixtures.test-support'
import {
  fullBatchLatencyFixture,
  latencyCalibrationDecisionFixture,
  nativeLatencyBacktestFixture,
} from './latency.test-support'
import { completeLatencyArtifactFixture } from './latency-report.test-support'
import { bindLatencyStressSources, verifyLatencyStressImages } from './latency-report'

const nativeTest = process.env['BAYN_TEST_REPLAY_IMAGE'] === '1' ? test : test.skip

test('the rebuilt frozen control binds its own compiler, original source tree and all registered policy material', () => {
  const policy = registrationFixture().policies.find((policy) => policy.policy === JevResearchPolicy.Deployed)!
  const executableSha256 = testHash('frozen executable')
  const compiler = {
    schemaVersion: 'bayn.frozen-control-compiler.v1',
    sourceRevision: policy.sourceRevision,
    origin: frozenControlOrigin,
    strategy: frozenDeployedControlIdentity,
    bunVersion: '1.4.2',
    executableSha256,
    adapterSha256: testHash('adapter'),
    files: { 'services/bayn/src/backtest-command.ts': testHash('original source') },
    dependencies: { 'effect@4.0.0-beta.102/package.json': testHash('original dependencies') },
  }
  expect(Result.isSuccess(bindFrozenReplayImagePolicy(compiler, policy, executableSha256))).toBe(true)
  for (const field of [
    'sourceRevision',
    'strategyHash',
    'parametersHash',
    'protocolHash',
    'executionModelHash',
    'promptsHash',
    'continuationAndExitsHash',
  ] as const)
    expect(
      Result.isFailure(
        bindFrozenReplayImagePolicy(compiler, { ...policy, [field]: testHash(field) }, executableSha256),
      ),
    ).toBe(true)
  for (const changed of [
    { ...compiler, origin: { ...compiler.origin, serviceTree: '0'.repeat(40) } },
    { ...compiler, files: {} },
    { ...compiler, dependencies: {} },
    { ...compiler, executableSha256: testHash('other executable') },
  ])
    expect(Result.isFailure(bindFrozenReplayImagePolicy(changed, policy, executableSha256))).toBe(true)
})

test('manifest identity preserves exact bytes and only permits crane newline framing', () => {
  const bytes = new TextEncoder().encode('{"schemaVersion":2}')
  const digest = `sha256:${sha256(bytes)}`
  expect(Result.getOrThrow(verifiedManifestBytes(bytes, digest, bytes.length))).toEqual(bytes)
  expect(
    Result.getOrThrow(verifiedManifestBytes(Buffer.concat([bytes, Buffer.from('\n')]), digest, bytes.length)),
  ).toEqual(bytes)
  expect(Result.isFailure(verifiedManifestBytes(Buffer.concat([bytes, Buffer.from(' \n')]), digest))).toBe(true)
  expect(Result.isFailure(verifiedManifestBytes(bytes, digest, bytes.length + 1))).toBe(true)
  expect(Result.isFailure(verifiedManifestBytes(bytes, `sha256:${testHash('different')}`))).toBe(true)
})

test.each([JevResearchPolicy.Ablation, JevResearchPolicy.Momentum])(
  'image policy membership binds %s independently while retaining the candidate OCI root',
  (policy) => {
    const policies = Result.getOrThrow(Result.flatMap(loadActiveStrategyProtocol(), nativeReplayPolicyManifest))
    const root = policies.find((p) => p.policy === JevResearchPolicy.Candidate)
    const ablation = registrationFixture().policies.find((p) => p.policy === policy)
    if (root === undefined || ablation === undefined) throw new Error('Missing compiled policy')
    const dependencies = Schema.decodeUnknownSync(JevCompilerDependencyReceiptSchema)({
      schemaVersion: 'bayn.jev-compiler-dependencies.v4',
      sourceRevision: ablation.sourceRevision,
      bunVersion: '1.4.2',
      files: {},
      controlFiles: {},
      compilerFiles: {},
      nativeReplayPolicies: policies,
    })
    const labels = {
      'proompteng.ai/bayn.strategy-behavior-hash': root.strategy.behaviorHash,
      'proompteng.ai/bayn.strategy-parameter-hash': root.strategy.parameterHash,
      'proompteng.ai/bayn.strategy-protocol-hash': root.protocolHash,
    }
    expect(Result.isSuccess(bindReplayImagePolicy(dependencies, labels, ablation))).toBe(true)
    for (const changed of [
      { ...dependencies, nativeReplayPolicies: [root] },
      { ...dependencies, nativeReplayPolicies: [root, root] },
      {
        ...dependencies,
        nativeReplayPolicies: policies.map((p) => (p.policy === policy ? { ...p, strategy: root.strategy } : p)),
      },
    ])
      expect(Result.isFailure(bindReplayImagePolicy(changed, labels, ablation))).toBe(true)
    expect(
      Result.isFailure(
        bindReplayImagePolicy(
          dependencies,
          { ...labels, 'proompteng.ai/bayn.strategy-parameter-hash': ablation.parametersHash },
          ablation,
        ),
      ),
    ).toBe(true)
  },
)

nativeTest(
  'registry digest chain verifies Nix image members and rejects forged source, executable and layer bytes',
  async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'bayn-image-registry-test-' })
        const native = yield* latencyCalibrationDecisionFixture
        const calibration = fullBatchLatencyFixture(native.document, native.native)
        const initial = nativeLatencyBacktestFixture(calibration)
        const base = initial.registration.policies[0]
        if (base === undefined) throw new Error('Missing candidate fixture')
        const executable = 'throw new Error("inspection must never execute image code")\n'
        const dependencies = {
          schemaVersion: 'bayn.jev-compiler-dependencies.v4',
          sourceRevision: base.sourceRevision,
          bunVersion: '1.4.2',
          files: { 'node_modules/example/index.js': testHash('dependency') },
          controlFiles: {},
          compilerFiles: {},
          nativeReplayPolicies: Result.getOrThrow(
            Result.flatMap(loadActiveStrategyProtocol(), nativeReplayPolicyManifest),
          ),
        }
        yield* fs.writeFileString(`${directory}/executable`, executable)
        yield* fs.writeFileString(`${directory}/dependencies`, JSON.stringify(dependencies))
        const frozen = {
          schemaVersion: 'bayn.frozen-control-compiler.v1',
          sourceRevision: base.sourceRevision,
          origin: frozenControlOrigin,
          strategy: frozenDeployedControlIdentity,
          bunVersion: '1.4.2',
          executableSha256: sha256(executable),
          adapterSha256: testHash('adapter'),
          files: { 'services/bayn/src/backtest-command.ts': testHash('source') },
          dependencies: { 'effect@4.0.0-beta.102/package.json': testHash('old dependencies') },
        }
        yield* fs.writeFileString(`${directory}/frozen`, JSON.stringify(frozen))
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const child = yield* spawner.spawn(
          ChildProcess.make(
            'python3',
            [
              '-c',
              `
import io, pathlib, sys, tarfile
root = pathlib.Path(sys.argv[1])
with tarfile.open(root / 'layer.tar', 'w') as archive:
    for source, target in [('executable', 'backtest-command.js'), ('dependencies', 'jev-compiler-dependencies.json'),('executable','frozen-control-command.js'),('frozen','frozen-control-compiler.json')]:
        data = (root / source).read_bytes()
        path = 'nix/store/test-bayn/app/services/bayn/dist/' + target
        entry = tarfile.TarInfo(path)
        entry.size = len(data)
        archive.addfile(entry, io.BytesIO(data))
        link = tarfile.TarInfo('app/services/bayn/dist/' + target)
        link.type = tarfile.SYMTYPE
        link.linkname = '/' + path
        archive.addfile(link)
`,
              directory,
            ],
            { stdin: 'ignore', stdout: 'ignore', stderr: 'inherit' },
          ),
        )
        expect(Number(yield* child.exitCode)).toBe(0)
        const tar = yield* fs.readFile(`${directory}/layer.tar`)
        const compressed = gzipSync(tar)
        const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
        const descriptor = (mediaType: string, bytes: Uint8Array) => ({
          mediaType,
          digest: `sha256:${sha256(bytes)}`,
          size: bytes.length,
        })
        const layer = descriptor('application/vnd.oci.image.layer.v1.tar+gzip', compressed)
        const config = encode({
          architecture: 'amd64',
          os: 'linux',
          rootfs: { type: 'layers', diff_ids: [`sha256:${sha256(tar)}`] },
          config: {
            Labels: {
              'org.opencontainers.image.source': 'https://github.com/proompteng/lab',
              'org.opencontainers.image.revision': base.sourceRevision,
              'proompteng.ai/bayn.strategy-behavior-hash': base.strategyHash,
              'proompteng.ai/bayn.strategy-parameter-hash': base.parametersHash,
              'proompteng.ai/bayn.strategy-protocol-hash': base.protocolHash,
            },
          },
        })
        const configDescriptor = descriptor('application/vnd.oci.image.config.v1+json', config)
        const manifest = encode({
          schemaVersion: 2,
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          config: configDescriptor,
          layers: [layer],
        })
        const manifestDescriptor = descriptor('application/vnd.oci.image.manifest.v1+json', manifest)
        const index = encode({
          schemaVersion: 2,
          mediaType: 'application/vnd.oci.image.index.v1+json',
          manifests: [{ ...manifestDescriptor, platform: { os: 'linux', architecture: 'amd64' } }],
        })
        const blobs = new Map([
          [layer.digest, { type: layer.mediaType, bytes: new Uint8Array(compressed) }],
          [configDescriptor.digest, { type: configDescriptor.mediaType, bytes: config }],
          [manifestDescriptor.digest, { type: manifestDescriptor.mediaType, bytes: manifest }],
          [`sha256:${sha256(index)}`, { type: 'application/vnd.oci.image.index.v1+json', bytes: index }],
        ])
        const server = yield* HttpServer.HttpServer
        const requested: string[] = []
        let hangLayer = false
        let layerRequested = yield* Deferred.make<void>()
        let releaseLayer = yield* Deferred.make<void>()
        yield* server.serve(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            requested.push(request.url)
            if (request.url === '/v2/') return HttpServerResponse.empty({ status: 200 })
            const digest = request.url.split('/').at(-1) ?? ''
            if (hangLayer && digest === layer.digest) {
              yield* Deferred.succeed(layerRequested, undefined)
              yield* Deferred.await(releaseLayer)
            }
            const entry = blobs.get(digest)
            return entry === undefined
              ? HttpServerResponse.empty({ status: 404 })
              : HttpServerResponse.uint8Array(entry.bytes, {
                  contentType: entry.type,
                  headers: { 'docker-content-digest': digest },
                })
          }),
        )
        const repository = `${new URL(HttpServer.formatAddress(server.address)).host}/bayn`
        const policy = { ...base, imageDigest: sha256(index) }
        const directories: string[] = []
        const observedFs = {
          ...fs,
          makeTempDirectoryScoped: (options?: Parameters<typeof fs.makeTempDirectoryScoped>[0]) =>
            fs.makeTempDirectoryScoped(options).pipe(
              Effect.tap((path) =>
                Effect.sync(() => {
                  directories.push(path)
                }),
              ),
            ),
        }
        const inspect = (
          overrides: Partial<typeof policy> = {},
          hash = sha256(executable),
          platform = ReplayImagePlatform.Amd64,
        ) =>
          VerifiedReplayImage.inspect({ ...policy, ...overrides }, repository, platform, hash).pipe(
            Effect.provideService(FileSystem.FileSystem, observedFs),
          )
        const image = yield* inspect()
        expect(image.receipt).toMatchObject({
          imageDigest: `sha256:${policy.imageDigest}`,
          manifestDigest: manifestDescriptor.digest,
          configDigest: configDescriptor.digest,
          executableSha256: sha256(executable),
          dependencyReceiptSha256: sha256(JSON.stringify(dependencies)),
          policyDefinitionHash: testHash(policy),
          runnerAuthentication: 'NOT_ESTABLISHED_BY_IMAGE_MEMBERSHIP',
        })
        expect(requested).toContain(`/v2/bayn/blobs/${layer.digest}`)
        const deployed = initial.registration.policies.find((policy) => policy.policy === JevResearchPolicy.Deployed)
        if (deployed === undefined) throw Error('Missing frozen policy')
        const frozenImage = yield* inspect({
          ...deployed,
          sourceRevision: policy.sourceRevision,
          imageDigest: policy.imageDigest,
        })
        expect(frozenImage.receipt.manifestDigest).toBe(image.receipt.manifestDigest)
        expect(frozenImage.receipt.dependencyReceiptSha256).toBe(sha256(JSON.stringify(frozen)))
        for (const control of initial.registration.policies.filter(
          (p) => p.policy === JevResearchPolicy.Ablation || p.policy === JevResearchPolicy.Momentum,
        )) {
          const controlImage = yield* inspect({
            ...control,
            sourceRevision: policy.sourceRevision,
            imageDigest: policy.imageDigest,
          })
          expect(controlImage.receipt.manifestDigest).toBe(image.receipt.manifestDigest)
          expect(controlImage.receipt.policyDefinitionHash).not.toBe(image.receipt.policyDefinitionHash)
        }
        const replay = nativeLatencyBacktestFixture(calibration, {
          imageRepository: repository,
          imageDigest: `sha256:${policy.imageDigest}`,
        })
        const artifact = completeLatencyArtifactFixture(replay, sha256(executable), ReplayImagePlatform.Amd64)
        const verified = yield* verifyLatencyStressImages(
          [artifact.descriptor],
          replay.registration,
          artifact.artifacts,
        )
        const receipts = yield* Effect.fromResult(
          bindLatencyStressSources(
            [artifact.descriptor],
            replay.registration,
            replay.cut,
            artifact.artifacts,
            artifact.sources,
            verified,
          ),
        )
        expect(receipts[0]?.image?.manifestDigest).toBe(manifestDescriptor.digest)
        expect(receipts[0]?.executionReceiptHash).toBeNull()
        expect(receipts[0]?.economics).toBeNull()
        expect(
          Result.getOrThrow(
            bindLatencyStressSources(
              [artifact.descriptor],
              replay.registration,
              replay.cut,
              artifact.artifacts,
              artifact.sources,
            ),
          )[0]?.economics,
        ).toBeNull()
        for (const invalid of [
          inspect({ sourceRevision: 'f'.repeat(40) }),
          inspect({ strategyHash: testHash('other strategy') }),
          inspect({}, testHash('other executable')),
          inspect({}, sha256(executable), ReplayImagePlatform.Arm64),
        ])
          expect(Exit.isFailure(yield* Effect.exit(invalid))).toBe(true)
        const original = blobs.get(layer.digest)
        if (original === undefined) throw new Error('Missing layer')
        blobs.set(layer.digest, { ...original, bytes: new Uint8Array(gzipSync(Buffer.from('forged layer'))) })
        expect(Exit.isFailure(yield* Effect.exit(inspect()))).toBe(true)
        blobs.set(layer.digest, original)
        blobs.set(configDescriptor.digest, { type: configDescriptor.mediaType, bytes: encode({ os: 'linux' }) })
        expect(Exit.isFailure(yield* Effect.exit(inspect()))).toBe(true)
        blobs.set(configDescriptor.digest, { type: configDescriptor.mediaType, bytes: config })
        const handles: ChildProcessSpawner.ChildProcessHandle[] = []
        const observedSpawner = ChildProcessSpawner.make((cmd) =>
          spawner.spawn(cmd).pipe(
            Effect.tap((handle) =>
              Effect.sync(() => {
                handles.push(handle)
              }),
            ),
          ),
        )
        hangLayer = true
        const fiber = yield* inspect().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observedSpawner),
          Effect.forkScoped,
        )
        yield* Deferred.await(layerRequested).pipe(Effect.timeout('10 seconds'))
        yield* Fiber.interrupt(fiber)
        yield* Deferred.succeed(releaseLayer, undefined)
        expect(handles.length).toBeGreaterThan(0)
        for (const handle of handles) expect(yield* handle.isRunning).toBe(false)
        layerRequested = yield* Deferred.make<void>()
        releaseLayer = yield* Deferred.make<void>()
        yield* Effect.gen(function* () {
          const timed = yield* inspect().pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observedSpawner),
            Effect.exit,
            Effect.forkScoped,
          )
          yield* Deferred.await(layerRequested)
          yield* TestClock.adjust('5 minutes')
          expect(Exit.isFailure(yield* Fiber.join(timed))).toBe(true)
          yield* Deferred.succeed(releaseLayer, undefined)
        }).pipe(Effect.provide(TestClock.layer()))
        for (const handle of handles) expect(yield* handle.isRunning).toBe(false)
        for (const path of directories) expect(yield* fs.exists(path)).toBe(false)
        const defect = new Error('spawner defect')
        const defectExit = yield* inspect().pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => Effect.die(defect)),
          ),
          Effect.exit,
        )
        expect(Exit.isFailure(defectExit) && Cause.hasDies(defectExit.cause)).toBe(true)
      }).pipe(
        Effect.scoped,
        Effect.provide(NodeHttpServer.layer(createServer, { host: '127.0.0.1', port: 0 })),
        Effect.provide(NodeServices.layer),
      ),
    )
  },
  60000,
)
