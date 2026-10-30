import { Effect, FileSystem, Result, Schema, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

import { canonicalHashV1Result, sha256 } from '../hash'
import { JevCompilerDependencyReceiptSchema } from '../jev/instruction-variant'
import { JevResearchPolicy } from '../jev/acceptance'
import { JevBatchPlanVersion } from '../jev/batch'
import { JevProtocolSchema } from '../jev/protocol'
import { RepeatedMomentumPolicySchema } from '../strategy/repeated-momentum/policy'
import { EntryAblationPolicySchema } from '../jev/entry-ablation-policy'
import { makeStrategyProtocolHashResult } from '../contracts'
import { GitSourceRevisionSchema, ImageDigestSchema, ImageRepositorySchema, Sha256Schema } from '../schemas'
import { SystemAssessmentError } from './economics'
import type { SystemRegistration } from './policy'

import { ReplayImagePlatform } from './replay-image-platform'
import {
  frozenControlOrigin,
  frozenDeployedControlIdentity,
  frozenControlPrompts,
  frozenControlContinuation,
} from './frozen-control-identity'

const FrozenCompiler = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.frozen-control-compiler.v1'),
  sourceRevision: GitSourceRevisionSchema,
  origin: Schema.Unknown,
  strategy: Schema.Unknown,
  bunVersion: Schema.Literal('1.4.2'),
  executableSha256: Sha256Schema,
  adapterSha256: Sha256Schema,
  files: Schema.Record(Schema.String, Sha256Schema),
  dependencies: Schema.Record(Schema.String, Sha256Schema),
})

const Descriptor = Schema.Struct({
  mediaType: Schema.String,
  digest: ImageDigestSchema,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
const Manifest = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  mediaType: Schema.Literals([
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
  ]),
  config: Descriptor,
  layers: Schema.Array(Descriptor),
})
const Index = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  mediaType: Schema.Literals([
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
  ]),
  manifests: Schema.Array(
    Schema.Struct({
      ...Descriptor.fields,
      platform: Schema.optionalKey(Schema.Struct({ os: Schema.String, architecture: Schema.String })),
    }),
  ),
})
const Config = Schema.Struct({
  os: Schema.Literal('linux'),
  architecture: Schema.Literals(['amd64', 'arm64']),
  config: Schema.Struct({ Labels: Schema.Record(Schema.String, Schema.String) }),
})

export const ReplayImageReceiptSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.replay-image-membership.v1'),
  repository: ImageRepositorySchema,
  imageDigest: ImageDigestSchema,
  platform: Schema.Enum(ReplayImagePlatform),
  manifestDigest: ImageDigestSchema,
  configDigest: ImageDigestSchema,
  sourceRevision: GitSourceRevisionSchema,
  executableSha256: Sha256Schema,
  dependencyReceiptSha256: Sha256Schema,
  policyDefinitionHash: Sha256Schema,
  assurance: Schema.Literal('REGISTERED_IMAGE_MEMBERSHIP'),
  runnerAuthentication: Schema.Literal('NOT_ESTABLISHED_BY_IMAGE_MEMBERSHIP'),
})

const failure = (message: string, cause?: unknown) => new SystemAssessmentError({ message, cause })
type Policy = SystemRegistration['policies'][number]

export const bindFrozenReplayImagePolicy = (raw: unknown, policy: Policy, executableSha256: string) =>
  Result.gen(function* () {
    const compiler = yield* Schema.decodeUnknownResult(FrozenCompiler)(raw)
    if (
      compiler.sourceRevision !== policy.sourceRevision ||
      compiler.executableSha256 !== executableSha256 ||
      policy.policy !== JevResearchPolicy.Deployed ||
      policy.strategyHash !== frozenDeployedControlIdentity.strategyHash ||
      policy.parametersHash !== frozenDeployedControlIdentity.parametersHash ||
      policy.protocolHash !== frozenDeployedControlIdentity.protocolHash ||
      policy.executionModelHash !== frozenControlOrigin.executionModelHash ||
      policy.promptsHash !== (yield* canonicalHashV1Result(frozenControlPrompts)) ||
      policy.continuationAndExitsHash !== (yield* canonicalHashV1Result(frozenControlContinuation)) ||
      (yield* canonicalHashV1Result(compiler.origin)) !== (yield* canonicalHashV1Result(frozenControlOrigin)) ||
      (yield* canonicalHashV1Result(compiler.strategy)) !==
        (yield* canonicalHashV1Result(frozenDeployedControlIdentity)) ||
      Object.keys(compiler.files).length === 0 ||
      Object.keys(compiler.dependencies).length === 0
    )
      return yield* Result.fail(
        failure('Frozen control compiler differs from its original authenticated source or registered carrier'),
      )
  })

/** OCI labels identify the application root; the in-image manifest binds each compiled replay policy. */
export const bindReplayImagePolicy = (
  dependencies: typeof JevCompilerDependencyReceiptSchema.Type,
  labels: Readonly<Record<string, string>>,
  policy: Policy,
) =>
  Result.gen(function* () {
    const entries = dependencies.nativeReplayPolicies
    const root = entries.find((entry) => entry.policy === JevResearchPolicy.Candidate)
    const selected = entries.find((entry) => entry.policy === policy.policy)
    if (
      entries.length !== 3 ||
      new Set(entries.map((entry) => entry.policy)).size !== entries.length ||
      root === undefined ||
      selected === undefined ||
      labels['proompteng.ai/bayn.strategy-behavior-hash'] !== root.strategy.behaviorHash ||
      labels['proompteng.ai/bayn.strategy-parameter-hash'] !== root.strategy.parameterHash ||
      labels['proompteng.ai/bayn.strategy-protocol-hash'] !== root.protocolHash ||
      selected.strategy.behaviorHash !== policy.strategyHash ||
      selected.strategy.parameterHash !== policy.parametersHash ||
      selected.protocolHash !== policy.protocolHash
    )
      return yield* Result.fail(
        failure('Compiled replay policy manifest differs from the image root or registered policy'),
      )
    for (const entry of entries)
      if (
        entry.protocolHash !== (yield* makeStrategyProtocolHashResult(entry.strategy)) ||
        (entry.policy === JevResearchPolicy.Candidate
          ? entry.planVersion !== JevBatchPlanVersion.V8 ||
            !Schema.is(JevProtocolSchema.fields.schemaVersion)(entry.strategy.parameterSchemaVersion)
          : entry.policy === JevResearchPolicy.Ablation
            ? entry.planVersion !== JevBatchPlanVersion.Ablation ||
              !Schema.is(EntryAblationPolicySchema.fields.schemaVersion)(entry.strategy.parameterSchemaVersion)
            : entry.planVersion !== null ||
              !Schema.is(RepeatedMomentumPolicySchema.fields.schemaVersion)(entry.strategy.parameterSchemaVersion))
      )
        return yield* Result.fail(failure('Compiled replay policy protocol identity does not reproduce'))
  })

/** crane prints a newline after manifests; only remove it when the digest proves that exact encoding. */
export const verifiedManifestBytes = (bytes: Uint8Array, digest: string, size?: number) => {
  const candidates = bytes.at(-1) === 10 ? [bytes, bytes.subarray(0, -1)] : [bytes]
  const matched = candidates.find(
    (candidate) => `sha256:${sha256(candidate)}` === digest && (size === undefined || candidate.length === size),
  )
  return matched === undefined
    ? Result.fail(failure('Registry manifest bytes differ from their registered digest or size'))
    : Result.succeed(matched)
}

export const runReplayEvidenceCommand = (executable: string, args: readonly string[], limit = 4 * 1024 * 1024) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const child = yield* spawner.spawn(ChildProcess.make(executable, args, { stdin: 'ignore' }))
    let size = 0
    const output = child.stdout.pipe(
      Stream.runFoldEffect(
        (): Uint8Array[] => [],
        (chunks, chunk) => {
          size += chunk.length
          return size > limit
            ? Effect.fail(failure('Replay evidence command exceeded its output bound'))
            : Effect.succeed([...chunks, chunk])
        },
      ),
    )
    const [chunks, code, stderr] = yield* Effect.all(
      [
        output,
        child.exitCode,
        child.stderr.pipe(
          Stream.decodeText,
          Stream.runFold(
            () => '',
            (text, chunk) => (text + chunk).slice(0, 4096),
          ),
        ),
      ],
      { concurrency: 'unbounded' },
    )
    if (Number(code) !== 0)
      return yield* failure(`Replay evidence command failed: ${executable} ${args[0]} (${code})`, new Error(stderr))
    return new Uint8Array(Buffer.concat(chunks))
  }).pipe(Effect.scoped)

// Resolve symlinks within the exported image, including Nix's absolute store links. Never extract or execute image files.
const readMembers = `
import hashlib, json, posixpath, sys, tarfile
def normalize(path):
    return posixpath.normpath('/' + path).lstrip('/')
with tarfile.open(sys.argv[1], 'r:') as archive:
    members = {}
    for member in archive:
        name = normalize(member.name)
        if name in members:
            raise ValueError('duplicate normalized image member')
        members[name] = member
    def read(path, bound):
        path = normalize(path)
        for _ in range(64):
            parts = path.split('/')
            replaced = False
            for index in range(1, len(parts) + 1):
                prefix = '/'.join(parts[:index])
                entry = members.get(prefix)
                if entry is not None and (entry.issym() or entry.islnk()):
                    target = entry.linkname
                    if entry.issym() and not target.startswith('/'):
                        target = posixpath.join(posixpath.dirname(prefix), target)
                    path = normalize(posixpath.join(target, *parts[index:]))
                    replaced = True
                    break
            if replaced:
                continue
            entry = members.get(path)
            if entry is None or not entry.isfile() or entry.size > bound:
                raise ValueError('missing, nonregular or oversized image member')
            with archive.extractfile(entry) as stream:
                data = stream.read(bound + 1)
            if len(data) != entry.size:
                raise ValueError('image member size mismatch')
            return data
        raise ValueError('cyclic or excessive image links')
    frozen = sys.argv[2] == 'DEPLOYED_BAYN'
    executable = read('app/services/bayn/dist/' + ('frozen-control-command.js' if frozen else 'backtest-command.js'), 67108864)
    receipt = read('app/services/bayn/dist/' + ('frozen-control-compiler.json' if frozen else 'jev-compiler-dependencies.json'), 4194304)
    print(json.dumps({'executableSha256': hashlib.sha256(executable).hexdigest(),
        'dependencyReceiptSha256': hashlib.sha256(receipt).hexdigest(),
        'dependencies': json.loads(receipt)}))
`

/** This value is produced by inspecting the registry, never by decoding a caller's claimed verification flag. */
export class VerifiedReplayImage {
  private constructor(readonly receipt: typeof ReplayImageReceiptSchema.Type) {}

  static inspect = (policy: Policy, repositoryInput: string, platform: ReplayImagePlatform, executableSha256: string) =>
    Effect.gen(function* () {
      const repository = yield* Schema.decodeUnknownEffect(ImageRepositorySchema)(repositoryInput)
      const imageDigest = yield* Schema.decodeUnknownEffect(ImageDigestSchema)(`sha256:${policy.imageDigest}`)
      const root = yield* Effect.fromResult(
        verifiedManifestBytes(
          yield* runReplayEvidenceCommand('crane', ['manifest', `${repository}@${imageDigest}`]),
          imageDigest,
        ),
      )
      const decode = <S extends Schema.Top>(schema: S, bytes: Uint8Array) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(new TextDecoder().decode(bytes))
      const index = Schema.decodeUnknownResult(Schema.fromJsonString(Index))(new TextDecoder().decode(root))
      let manifestDigest = imageDigest
      let manifestBytes = root
      if (Result.isSuccess(index)) {
        const matches = index.success.manifests.filter(
          (entry) => `${entry.platform?.os}/${entry.platform?.architecture}` === platform,
        )
        const selected = matches[0]
        if (matches.length !== 1 || selected === undefined)
          return yield* failure('Registered image must select exactly one requested platform manifest')
        manifestDigest = selected.digest
        manifestBytes = yield* Effect.fromResult(
          verifiedManifestBytes(
            yield* runReplayEvidenceCommand('crane', ['manifest', `${repository}@${manifestDigest}`]),
            manifestDigest,
            selected.size,
          ),
        )
      }
      const manifest = yield* decode(Manifest, manifestBytes)
      const configBytes = yield* runReplayEvidenceCommand('crane', ['blob', `${repository}@${manifest.config.digest}`])
      if (`sha256:${sha256(configBytes)}` !== manifest.config.digest || configBytes.length !== manifest.config.size)
        return yield* failure('Image configuration digest or size differs from the selected manifest')
      const config = yield* decode(Config, configBytes)
      const labels = config.config.Labels
      if (
        `${config.os}/${config.architecture}` !== platform ||
        labels['org.opencontainers.image.source'] !== 'https://github.com/proompteng/lab' ||
        labels['org.opencontainers.image.revision'] !== policy.sourceRevision
      )
        return yield* failure('Image platform, source or strategy labels differ from the registered policy')
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'bayn-replay-image-' })
      const archive = `${directory}/image.tar`
      yield* runReplayEvidenceCommand('crane', ['export', `${repository}@${manifestDigest}`, archive])
      const members = yield* decode(
        Schema.Struct({
          executableSha256: Sha256Schema,
          dependencyReceiptSha256: Sha256Schema,
          dependencies: Schema.Unknown,
        }),
        yield* runReplayEvidenceCommand('python3', ['-c', readMembers, archive, policy.policy]),
      )
      if (members.executableSha256 !== executableSha256)
        return yield* failure('Replay executable or compiler dependency receipt differs from the registered image')
      if (policy.policy === JevResearchPolicy.Deployed) {
        yield* Effect.fromResult(bindFrozenReplayImagePolicy(members.dependencies, policy, executableSha256))
      } else {
        const dependencies = yield* Schema.decodeUnknownEffect(JevCompilerDependencyReceiptSchema)(members.dependencies)
        if (dependencies.sourceRevision !== policy.sourceRevision || Object.keys(dependencies.files).length === 0)
          return yield* failure('Replay compiler differs from its registered source')
        yield* Effect.fromResult(bindReplayImagePolicy(dependencies, labels, policy))
      }
      return new VerifiedReplayImage({
        schemaVersion: 'bayn.replay-image-membership.v1',
        repository,
        imageDigest,
        platform,
        manifestDigest,
        configDigest: manifest.config.digest,
        sourceRevision: policy.sourceRevision,
        executableSha256,
        dependencyReceiptSha256: members.dependencyReceiptSha256,
        policyDefinitionHash: yield* Effect.fromResult(canonicalHashV1Result(policy)),
        assurance: 'REGISTERED_IMAGE_MEMBERSHIP',
        runnerAuthentication: 'NOT_ESTABLISHED_BY_IMAGE_MEMBERSHIP',
      })
    }).pipe(
      Effect.scoped,
      Effect.timeout('5 minutes'),
      Effect.mapError((cause) => failure('Registered replay image verification failed', cause)),
    )
}
