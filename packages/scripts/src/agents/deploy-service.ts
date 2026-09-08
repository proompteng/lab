#!/usr/bin/env bun

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import YAML from 'yaml'
import { ensureCli, fatal, repoRoot, run } from '../shared/cli'
import { execGit } from '../shared/git'
import { buildAndPushNixImage } from '../shared/nix-oci-deploy'

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
  tag: string
  platforms: string[]
  apply: boolean
  dryRun: boolean
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

type AgentsServiceImagePlan = {
  service: string
  imageName: string
  packageAttr: string
  repository: string
  tag: string
}

const buildAgentsServiceImagePlans = (
  options: Pick<
    Options,
    | 'registry'
    | 'repository'
    | 'controlPlaneRepository'
    | 'agentsShellRepository'
    | 'runnerRepository'
    | 'tag'
    | 'platforms'
  >,
): AgentsServiceImagePlan[] => [
  {
    service: 'agents-controller',
    imageName: 'agents-controller',
    packageAttr: 'agents-controller-image',
    repository: options.repository,
    tag: options.tag,
  },
  {
    service: 'agents-control-plane',
    imageName: 'agents-control-plane',
    packageAttr: 'agents-control-plane-image',
    repository: options.controlPlaneRepository,
    tag: options.tag,
  },
  {
    service: 'agents-shell',
    imageName: 'agents-shell',
    packageAttr: 'agents-shell-image',
    repository: options.agentsShellRepository,
    tag: options.tag,
  },
  {
    service: 'agents-codex-runner',
    imageName: 'agents-codex-runner',
    packageAttr: 'agents-codex-runner-image',
    repository: options.runnerRepository,
    tag: options.tag,
  },
]

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false
  return fallback
}

const nativePlatformValues = new Set(['0', 'false', 'host', 'local', 'native', 'none', 'off'])

const parsePlatforms = (value: string | undefined): string[] | undefined => {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  if (nativePlatformValues.has(normalized)) return []

  const platforms = value
    .split(',')
    .map((platform) => platform.trim())
    .filter(Boolean)
  return platforms.length > 0 ? platforms : undefined
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
    if (arg === '--dry-run') {
      options.dryRun = true
      options.apply = false
      continue
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
  const runnerRepository = process.env.AGENTS_RUNNER_IMAGE_REPOSITORY ?? 'lab/agents-codex-runner'
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
    tag,
    platforms,
    apply: args.apply ?? parseBoolean(process.env.AGENTS_APPLY, true),
    dryRun: args.dryRun ?? parseBoolean(process.env.AGENTS_DRY_RUN, false),
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

const normalizeDigest = (value: string): string => {
  const trimmed = value.trim()
  return trimmed.includes('@') ? trimmed.slice(trimmed.lastIndexOf('@') + 1) : trimmed
}

const buildAgentsServiceImages = async (options: Options) => {
  const sourceSha = execGit(['rev-parse', 'HEAD'])
  const plans = buildAgentsServiceImagePlans(options)

  const pins: Record<string, ImagePin> = {}
  for (const plan of plans) {
    const result = await buildAndPushNixImage({
      service: plan.service,
      imageName: plan.imageName,
      packageAttr: plan.packageAttr,
      registry: options.registry,
      repository: plan.repository,
      tag: plan.tag,
      sourceSha,
      dryRun: options.dryRun,
      contractPath: `.artifacts/agents/${plan.service}-manual-release-contract.json`,
    })
    pins[plan.service] = {
      repository: result.image,
      tag: result.tag,
      digest: normalizeDigest(result.digest),
    }
  }

  return {
    controller: pins['agents-controller'] ?? fatal('agents-controller Nix image result was not produced'),
    controlPlane: pins['agents-control-plane'] ?? fatal('agents-control-plane Nix image result was not produced'),
    agentsShell: pins['agents-shell'] ?? fatal('agents-shell Nix image result was not produced'),
    runner: pins['agents-codex-runner'] ?? fatal('agents-codex-runner Nix image result was not produced'),
  }
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
  const servicePins = await buildAgentsServiceImages(options)
  if (options.dryRun) {
    console.log('Dry run complete; Agents values and cluster state were not changed.')
    return
  }

  updateValuesFile(
    options.valuesPath,
    servicePins.controller.repository,
    servicePins.controller.tag,
    servicePins.controller.digest,
    servicePins.controlPlane.repository,
    servicePins.controlPlane.tag,
    servicePins.controlPlane.digest,
    servicePins.agentsShell.repository,
    servicePins.agentsShell.tag,
    servicePins.agentsShell.digest,
    servicePins.runner.repository,
    servicePins.runner.tag,
    servicePins.runner.digest,
    {
      sourceHeadSha: execGit(['rev-parse', 'HEAD']),
      gitopsRevision: execGit(['rev-parse', 'HEAD']),
      sourceCiRunId: process.env.GITHUB_RUN_ID,
      sourceCiConclusion: process.env.AGENTS_SOURCE_CI_CONCLUSION ?? 'success',
      manifestImageDigest: servicePins.controlPlane.digest,
      servingBuildCommit: execGit(['rev-parse', 'HEAD']),
      servingImageDigest: servicePins.controlPlane.digest,
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
  filterDirectApplyManifests,
  isArgoHookManifest,
  renderAndApply,
  updateValuesFile,
  buildAgentsServiceImages,
  resolveDatabaseSecretRequirement,
}
