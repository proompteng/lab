#!/usr/bin/env bun

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import YAML from 'yaml'
import { buildImages, resolveCacheRef, type BuildImageOptions } from './build-image'
import { ensureCli, fatal, repoRoot, run } from '../shared/cli'
import { buildAndPushDockerImage, inspectImageDigest } from '../shared/docker'
import { execGit } from '../shared/git'

type KubernetesManifest = {
  metadata?: {
    annotations?: Record<string, unknown>
  }
}

type Options = {
  kustomizePath: string
  valuesPath: string
  registry: string
  repository: string
  controlPlaneRepository: string
  agentsShellRepository: string
  runnerRepository: string
  runnerDockerfile: string
  codexAuthPath?: string
  tag: string
  platforms: string[]
  buildRunner: boolean
  apply: boolean
}

type ImagePin = {
  repository: string
  tag: string
  digest: string
}

type ReleaseMetadata = {
  sourceHeadSha?: string
  gitopsRevision?: string
  sourceCiRunId?: string
  sourceCiConclusion?: string
  manifestImageDigest?: string
  servingBuildCommit?: string
  servingImageDigest?: string
}

type DatabaseSecretRequirement = {
  namespace: string
  name: string
}

const CONTROL_PLANE_DOCKER_TARGET = 'control-plane'
const CONTROLLER_DOCKER_TARGET = 'controller'
const AGENTS_SHELL_DOCKER_TARGET = 'agents-shell'

const buildAgentsServiceImagePlans = (
  options: Pick<
    Options,
    'registry' | 'repository' | 'controlPlaneRepository' | 'agentsShellRepository' | 'tag' | 'platforms'
  >,
): BuildImageOptions[] => [
  {
    registry: options.registry,
    repository: options.repository,
    tag: options.tag,
    target: CONTROLLER_DOCKER_TARGET,
    platforms: options.platforms,
  },
  {
    registry: options.registry,
    repository: options.controlPlaneRepository,
    tag: options.tag,
    target: CONTROL_PLANE_DOCKER_TARGET,
    platforms: options.platforms,
  },
  {
    registry: options.registry,
    repository: options.agentsShellRepository,
    tag: options.tag,
    target: AGENTS_SHELL_DOCKER_TARGET,
    platforms: options.platforms,
  },
]

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false
  return fallback
}

const parsePlatforms = (value: string | undefined): string[] | undefined => {
  if (!value) return undefined
  const platforms = value
    .split(',')
    .map((platform) => platform.trim())
    .filter(Boolean)
  return platforms.length > 0 ? platforms : undefined
}

const resolveCodexAuthPath = (explicitPath?: string): string | undefined => {
  if (explicitPath) {
    const resolved = resolve(explicitPath)
    if (!existsSync(resolved)) {
      fatal(`Codex auth not found at explicit path ${resolved}.`)
    }
    return resolved
  }

  const defaultPath = resolve(process.env.HOME ?? '', '.codex/auth.json')
  return existsSync(defaultPath) ? defaultPath : undefined
}

const parseArgs = (argv: string[]): Partial<Options> => {
  const options: Partial<Options> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--kustomize-path') {
      options.kustomizePath = argv[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--kustomize-path=')) {
      options.kustomizePath = arg.slice('--kustomize-path='.length)
      continue
    }
    if (arg === '--values') {
      options.valuesPath = argv[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--values=')) {
      options.valuesPath = arg.slice('--values='.length)
      continue
    }
    if (arg === '--registry') {
      options.registry = argv[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--registry=')) {
      options.registry = arg.slice('--registry='.length)
      continue
    }
    if (arg === '--repository') {
      options.repository = argv[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--repository=')) {
      options.repository = arg.slice('--repository='.length)
      continue
    }
    if (arg === '--control-plane-repository') {
      options.controlPlaneRepository = argv[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--control-plane-repository=')) {
      options.controlPlaneRepository = arg.slice('--control-plane-repository='.length)
      continue
    }
    if (arg === '--runner-repository') {
      options.runnerRepository = argv[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--runner-repository=')) {
      options.runnerRepository = arg.slice('--runner-repository='.length)
      continue
    }
    if (arg === '--runner-dockerfile') {
      options.runnerDockerfile = argv[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--runner-dockerfile=')) {
      options.runnerDockerfile = arg.slice('--runner-dockerfile='.length)
      continue
    }
    if (arg === '--codex-auth-path') {
      options.codexAuthPath = argv[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--codex-auth-path=')) {
      options.codexAuthPath = arg.slice('--codex-auth-path='.length)
      continue
    }
    if (arg === '--tag') {
      options.tag = argv[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--tag=')) {
      options.tag = arg.slice('--tag='.length)
      continue
    }
    if (arg === '--no-apply') {
      options.apply = false
      continue
    }
    if (arg === '--skip-runner') {
      options.buildRunner = false
    }
  }
  return options
}

const resolveOptions = (): Options => {
  const args = parseArgs(process.argv.slice(2))
  const registry = args.registry ?? process.env.AGENTS_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository =
    args.repository ??
    process.env.AGENTS_CONTROLLER_IMAGE_REPOSITORY ??
    process.env.AGENTS_IMAGE_REPOSITORY ??
    'lab/agents-controller'
  const controlPlaneRepository =
    args.controlPlaneRepository ?? process.env.AGENTS_CONTROL_PLANE_IMAGE_REPOSITORY ?? 'lab/agents-control-plane'
  const agentsShellRepository = process.env.AGENTS_SHELL_IMAGE_REPOSITORY ?? 'lab/agents-shell'
  const runnerRepository =
    args.runnerRepository ??
    process.env.AGENTS_RUNNER_IMAGE_REPOSITORY ??
    process.env.AGENTS_CODEX_RUNNER_IMAGE_REPOSITORY ??
    'lab/agents-codex-runner'
  const runnerDockerfile =
    args.runnerDockerfile ?? process.env.AGENTS_RUNNER_DOCKERFILE ?? 'services/agents/Dockerfile.codex-runner'
  const codexAuthPath = resolveCodexAuthPath(args.codexAuthPath ?? process.env.CODEX_AUTH_PATH)
  const tag = args.tag ?? process.env.AGENTS_IMAGE_TAG ?? execGit(['rev-parse', '--short', 'HEAD'])
  const platforms = parsePlatforms(process.env.AGENTS_IMAGE_PLATFORMS) ?? ['linux/amd64', 'linux/arm64']

  return {
    kustomizePath: resolve(
      repoRoot,
      args.kustomizePath ?? process.env.AGENTS_KUSTOMIZE_PATH ?? 'argocd/applications/agents',
    ),
    valuesPath: resolve(
      repoRoot,
      args.valuesPath ?? process.env.AGENTS_VALUES_PATH ?? 'argocd/applications/agents/values.yaml',
    ),
    registry,
    repository,
    controlPlaneRepository,
    agentsShellRepository,
    runnerRepository,
    runnerDockerfile: resolve(repoRoot, runnerDockerfile),
    codexAuthPath,
    tag,
    platforms,
    buildRunner: args.buildRunner ?? parseBoolean(process.env.AGENTS_BUILD_RUNNER, true),
    apply: args.apply ?? parseBoolean(process.env.AGENTS_APPLY, true),
  }
}

const capture = async (cmd: string[], env?: Record<string, string | undefined>): Promise<string> => {
  const subprocess = Bun.spawn(cmd, {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: buildEnv(env),
  })

  void subprocess.stdin?.end()

  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ])

  if (exitCode !== 0) {
    fatal(`Command failed (${exitCode}): ${cmd.join(' ')}`, stderr)
  }

  return stdout.trim()
}

const captureStatus = async (cmd: string[], env?: Record<string, string | undefined>) => {
  const subprocess = Bun.spawn(cmd, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: buildEnv(env),
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ])
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() }
}

const buildEnv = (env?: Record<string, string | undefined>) =>
  Object.fromEntries(
    Object.entries(env ? { ...process.env, ...env } : process.env).filter(([, value]) => value !== undefined),
  ) as Record<string, string>

const fetchHelmV3 = (): { binary: string; tempDir: string } => {
  const version = process.env.HELM_V3_VERSION ?? 'v3.15.4'
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const os = process.platform === 'darwin' ? 'darwin' : 'linux'
  const url = `https://get.helm.sh/helm-${version}-${os}-${arch}.tar.gz`

  const tmpDir = mkdtempSync(join(tmpdir(), 'helm-v3-'))
  const archivePath = join(tmpDir, 'helm.tgz')
  const download = spawnSync('curl', ['-fsSL', url, '-o', archivePath])
  if (download.status !== 0) {
    fatal(`Failed to download helm ${version} from ${url}`, download.stderr?.toString())
  }

  const extract = spawnSync('tar', ['-xzf', archivePath, '-C', tmpDir])
  if (extract.status !== 0) {
    fatal(`Failed to extract helm archive ${archivePath}`, extract.stderr?.toString())
  }

  const binaryPath = join(tmpDir, `${os}-${arch}`, 'helm')
  return { binary: binaryPath, tempDir: tmpDir }
}

const resolveHelmBinary = (): { binary: string; tempDir?: string; shim?: string } => {
  const envBin = process.env.HELM_BIN
  if (envBin) return { binary: envBin }

  const helmPath = Bun.which('helm')
  if (helmPath) {
    const version = spawnSync(helmPath, ['version', '--short'], { encoding: 'utf8' })
    const output = typeof version.stdout === 'string' ? version.stdout.trim() : ''
    if (output.startsWith('v3.')) {
      return { binary: helmPath }
    }
  }

  const misePath = Bun.which('mise')
  if (misePath) {
    const version = (process.env.HELM_V3_VERSION ?? 'v3.15.4').replace(/^v/, '')
    const helmDir = mkdtempSync(join(tmpdir(), 'helm-mise-shim-'))
    const shimPath = join(helmDir, 'helm')
    const script = `#!/usr/bin/env bash\nset -euo pipefail\nexec ${misePath} x helm@${version} -- helm "$@"\n`
    writeFileSync(shimPath, script, { mode: 0o755 })
    return { binary: shimPath, tempDir: helmDir, shim: 'mise' }
  }

  return fetchHelmV3()
}

const writeHelmShim = (): { helmDir: string; helmBinary: string; cleanup: () => void } => {
  const helmResolved = resolveHelmBinary()
  if (helmResolved.shim === 'mise') {
    return {
      helmDir: helmResolved.tempDir ?? tmpdir(),
      helmBinary: helmResolved.binary,
      cleanup: () => helmResolved.tempDir && rmSync(helmResolved.tempDir, { recursive: true, force: true }),
    }
  }

  const helmBinary = helmResolved.binary
  const helmDir = mkdtempSync(join(tmpdir(), 'helm-shim-'))
  const shimPath = join(helmDir, 'helm')
  const script = `#!/usr/bin/env bash
set -euo pipefail
args=()
for a in "$@"; do
  if [[ "$a" == "-c" ]]; then
    continue
  fi
  args+=("$a")
done
exec ${helmBinary} "${'${'}args[@]}"
`
  writeFileSync(shimPath, script, { mode: 0o755 })
  const cleanup = () => {
    rmSync(helmDir, { recursive: true, force: true })
    if (helmResolved.tempDir) {
      rmSync(helmResolved.tempDir, { recursive: true, force: true })
    }
  }
  return { helmDir, helmBinary: shimPath, cleanup }
}

const updateValuesFile = (
  valuesPath: string,
  imageRepository: string,
  tag: string,
  digest: string,
  controlPlaneImageRepository: string,
  controlPlaneTag: string,
  controlPlaneDigest: string,
  agentsShellImageRepository: string,
  agentsShellTag: string,
  agentsShellDigest: string,
  runnerImageRepository: string,
  runnerTag: string,
  runnerDigest: string,
  releaseMetadata?: ReleaseMetadata,
) => {
  const raw = readFileSync(valuesPath, 'utf8')
  const doc = YAML.parse(raw) ?? {}

  doc.image ??= {}
  doc.image.repository = imageRepository
  doc.image.tag = tag
  doc.image.digest = digest

  doc.controllers ??= {}
  doc.controllers.image ??= {}
  doc.controllers.image.repository = imageRepository
  doc.controllers.image.tag = tag
  doc.controllers.image.digest = digest

  doc.controlPlane ??= {}
  doc.controlPlane.image ??= {}
  doc.controlPlane.image.repository = controlPlaneImageRepository
  doc.controlPlane.image.tag = controlPlaneTag
  doc.controlPlane.image.digest = controlPlaneDigest

  doc.agentsShell ??= {}
  doc.agentsShell.image ??= {}
  doc.agentsShell.image.repository = agentsShellImageRepository
  doc.agentsShell.image.tag = agentsShellTag
  doc.agentsShell.image.digest = agentsShellDigest

  doc.runner ??= {}
  doc.runner.image ??= {}
  doc.runner.image.repository = runnerImageRepository
  doc.runner.image.tag = runnerTag
  doc.runner.image.digest = runnerDigest

  if (releaseMetadata) {
    doc.controlPlane.env ??= {}
    doc.controlPlane.env.vars ??= {}
    const vars = doc.controlPlane.env.vars as Record<string, string>
    if (releaseMetadata.sourceHeadSha) vars.AGENTS_SOURCE_HEAD_SHA = releaseMetadata.sourceHeadSha
    if (releaseMetadata.gitopsRevision) vars.AGENTS_GITOPS_REVISION = releaseMetadata.gitopsRevision
    if (releaseMetadata.sourceCiRunId) vars.AGENTS_SOURCE_CI_RUN_ID = releaseMetadata.sourceCiRunId
    if (releaseMetadata.sourceCiConclusion) vars.AGENTS_SOURCE_CI_CONCLUSION = releaseMetadata.sourceCiConclusion
    if (releaseMetadata.manifestImageDigest) vars.AGENTS_MANIFEST_IMAGE_DIGEST = releaseMetadata.manifestImageDigest
    if (releaseMetadata.servingBuildCommit) vars.AGENTS_SERVING_BUILD_COMMIT = releaseMetadata.servingBuildCommit
    if (releaseMetadata.servingImageDigest) vars.AGENTS_SERVING_IMAGE_DIGEST = releaseMetadata.servingImageDigest
  }

  writeFileSync(valuesPath, YAML.stringify(doc, { lineWidth: 120 }))
  console.log(
    `Updated ${valuesPath} with ${imageRepository}:${tag}@${digest}, ${controlPlaneImageRepository}:${controlPlaneTag}@${controlPlaneDigest}, ${agentsShellImageRepository}:${agentsShellTag}@${agentsShellDigest}, and ${runnerImageRepository}:${runnerTag}@${runnerDigest}`,
  )
}

export const updateAgentsValuesFile = updateValuesFile

const readRunnerImagePin = (valuesPath: string): ImagePin => {
  const values = YAML.parse(readFileSync(valuesPath, 'utf8')) ?? {}
  const runnerImage = values.runner?.image
  const repository = typeof runnerImage?.repository === 'string' ? runnerImage.repository : ''
  const tag = typeof runnerImage?.tag === 'string' ? runnerImage.tag : ''
  const digest = typeof runnerImage?.digest === 'string' ? runnerImage.digest : ''
  if (!repository || !tag || !digest) {
    fatal(
      `Runner image pin missing from ${valuesPath}; cannot preserve runner image without repository, tag, and digest.`,
    )
  }
  return { repository, tag, digest }
}

const resolveDatabaseSecretRequirement = (
  values: unknown,
  namespace = process.env.AGENTS_NAMESPACE ?? 'agents',
): DatabaseSecretRequirement | null => {
  if (!values || typeof values !== 'object') return null
  const database = (values as { database?: unknown }).database
  if (!database || typeof database !== 'object') return null
  const db = database as {
    url?: unknown
    createSecret?: { enabled?: unknown; name?: unknown }
    secretRef?: { name?: unknown }
  }
  if (typeof db.url === 'string' && db.url.trim().length > 0) return null
  if (db.createSecret?.enabled === true) return null
  const name = typeof db.secretRef?.name === 'string' ? db.secretRef.name.trim() : ''
  return name ? { namespace, name } : null
}

const ensureDatabaseSecretReady = async (requirement: DatabaseSecretRequirement | null) => {
  if (!requirement) return
  ensureCli('kubectl')

  const target = await captureStatus([
    'kubectl',
    '-n',
    requirement.namespace,
    'get',
    'secret',
    requirement.name,
    '-o',
    'name',
  ])
  if (target.exitCode === 0) {
    console.log(`Database secret ${requirement.namespace}/${requirement.name} already exists`)
    return
  }

  fatal(
    `Database secret ${requirement.namespace}/${requirement.name} is missing. Create or migrate the Agents-owned database secret before applying.`,
  )
}

const isArgoHookManifest = (manifest: unknown): boolean => {
  if (!manifest || typeof manifest !== 'object') return false
  const annotations = (manifest as KubernetesManifest).metadata?.annotations
  return typeof annotations?.['argocd.argoproj.io/hook'] === 'string'
}

const filterDirectApplyManifests = (rendered: string): string => {
  const kept = YAML.parseAllDocuments(rendered)
    .filter((document) => {
      const manifest = document.toJSON()
      if (manifest === null || manifest === undefined) return false
      return !isArgoHookManifest(manifest)
    })
    .map((document) => document.toString({ lineWidth: 120 }).trim())
    .filter(Boolean)

  return kept.length > 0 ? `${kept.join('\n---\n')}\n` : ''
}

const renderAndApply = async (kustomizePath: string) => {
  ensureCli('kubectl')
  const { helmDir, helmBinary, cleanup } = writeHelmShim()
  const kubectl = Bun.which('kubectl') ?? fatal('Missing kubectl: install kubectl to render kustomize manifests')
  const renderEnv = { PATH: `${helmDir}:${process.env.PATH ?? ''}`, HELM_BIN: helmBinary }
  const rendered = await capture([kubectl, 'kustomize', kustomizePath, '--enable-helm'], renderEnv)
  const tmpDir = mkdtempSync(`${tmpdir()}/agents-render-`)
  const tmpPath = resolve(tmpDir, 'manifests.yaml')
  try {
    writeFileSync(tmpPath, filterDirectApplyManifests(rendered))
    await run('kubectl', ['apply', '--server-side', '--force-conflicts', '-f', tmpPath])
  } finally {
    cleanup()
    try {
      rmSync(tmpPath, { force: true })
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  }
}

const main = async () => {
  const options = resolveOptions()
  ensureCli('docker')
  ensureCli('curl')
  ensureCli('tar')

  const imageName = `${options.registry}/${options.repository}`
  const image = `${imageName}:${options.tag}`
  const controlPlaneImageName = `${options.registry}/${options.controlPlaneRepository}`
  const controlPlaneImage = `${controlPlaneImageName}:${options.tag}`
  const agentsShellImageName = `${options.registry}/${options.agentsShellRepository}`
  const agentsShellImage = `${agentsShellImageName}:${options.tag}`
  const runnerImageName = `${options.registry}/${options.runnerRepository}`
  const runnerImage = `${runnerImageName}:${options.tag}`

  await buildImages(buildAgentsServiceImagePlans(options))
  const runnerPin = options.buildRunner ? undefined : readRunnerImagePin(options.valuesPath)
  if (options.buildRunner) {
    if (!options.codexAuthPath) {
      console.warn('Codex auth not found at ~/.codex/auth.json; runner image will rely on runtime codex-auth mount.')
    }
    await buildAndPushDockerImage({
      registry: options.registry,
      repository: options.runnerRepository,
      tag: options.tag,
      context: repoRoot,
      dockerfile: options.runnerDockerfile,
      codexAuthPath: options.codexAuthPath,
      cacheRef: resolveCacheRef(
        undefined,
        process.env.AGENTS_RUNNER_BUILD_CACHE_REF,
        `${options.registry}/${options.runnerRepository}:buildcache`,
      ),
      platforms: options.platforms,
    })
  }

  const repoDigest = inspectImageDigest(image)
  const digest = repoDigest.includes('@') ? repoDigest.split('@')[1] : repoDigest

  const controlPlaneRepoDigest = inspectImageDigest(controlPlaneImage)
  const controlPlaneDigest = controlPlaneRepoDigest.includes('@')
    ? controlPlaneRepoDigest.split('@')[1]
    : controlPlaneRepoDigest
  const agentsShellRepoDigest = inspectImageDigest(agentsShellImage)
  const agentsShellDigest = agentsShellRepoDigest.includes('@')
    ? agentsShellRepoDigest.split('@')[1]
    : agentsShellRepoDigest
  const runnerRepoDigest = options.buildRunner ? inspectImageDigest(runnerImage) : runnerPin?.digest
  const runnerDigest =
    (runnerRepoDigest?.includes('@') ? runnerRepoDigest.split('@')[1] : runnerRepoDigest) ??
    fatal('Agents runner digest is empty.')

  updateValuesFile(
    options.valuesPath,
    imageName,
    options.tag,
    digest,
    controlPlaneImageName,
    options.tag,
    controlPlaneDigest,
    agentsShellImageName,
    options.tag,
    agentsShellDigest,
    runnerPin?.repository ?? runnerImageName,
    runnerPin?.tag ?? options.tag,
    runnerDigest,
    {
      sourceHeadSha: execGit(['rev-parse', 'HEAD']),
      gitopsRevision: execGit(['rev-parse', 'HEAD']),
      sourceCiRunId: process.env.GITHUB_RUN_ID,
      sourceCiConclusion: process.env.AGENTS_SOURCE_CI_CONCLUSION ?? 'success',
      manifestImageDigest: controlPlaneDigest,
      servingBuildCommit: execGit(['rev-parse', 'HEAD']),
      servingImageDigest: controlPlaneDigest,
    },
  )

  if (options.apply) {
    const updatedValues = YAML.parse(readFileSync(options.valuesPath, 'utf8'))
    await ensureDatabaseSecretReady(resolveDatabaseSecretRequirement(updatedValues))
    await renderAndApply(options.kustomizePath)
  }
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to build and deploy agents', error))
}

export const __private = {
  buildAgentsServiceImagePlans,
  parseArgs,
  parseBoolean,
  resolveOptions,
  resolveCodexAuthPath,
  filterDirectApplyManifests,
  isArgoHookManifest,
  renderAndApply,
  updateValuesFile,
  readRunnerImagePin,
  resolveDatabaseSecretRequirement,
}
