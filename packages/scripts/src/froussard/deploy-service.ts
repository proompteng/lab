#!/usr/bin/env bun

import { relative, resolve } from 'node:path'
import process from 'node:process'

import { ensureCli, fatal, repoRoot, run } from '../shared/cli'
import { buildAndPushDockerImage, inspectImageDigest } from '../shared/docker'

const defaultManifestPath = 'argocd/applications/froussard/knative-service.yaml'
const defaultRegistry = 'registry.ide-newton.ts.net'
const defaultRepository = 'lab/froussard'
const defaultDockerfile = 'apps/froussard/Dockerfile'
const defaultContext = '.'
const defaultPlatforms = ['linux/arm64']

const execGit = (args: string[]): string => {
  const result = Bun.spawnSync(['git', ...args], { cwd: repoRoot })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed`)
  }
  return result.stdout.toString().trim()
}

type CliArguments = {
  dryRun: boolean
}

const parseArguments = (): CliArguments => {
  const dryRun = process.argv.includes('--dry-run')
  return { dryRun }
}

const ensureVersions = () => {
  const version =
    process.env.FROUSSARD_VERSION?.trim() && process.env.FROUSSARD_VERSION.trim().length > 0
      ? process.env.FROUSSARD_VERSION.trim()
      : execGit(['describe', '--tags', '--always'])

  const commit =
    process.env.FROUSSARD_COMMIT?.trim() && process.env.FROUSSARD_COMMIT.trim().length > 0
      ? process.env.FROUSSARD_COMMIT.trim()
      : execGit(['rev-parse', 'HEAD'])

  if (!version) {
    throw new Error('Failed to determine FROUSSARD_VERSION')
  }
  if (!commit) {
    throw new Error('Failed to determine FROUSSARD_COMMIT')
  }

  return { version, commit }
}

const sanitizeTag = (value: string) => {
  const normalized = value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return normalized.length > 0 ? normalized : 'latest'
}

type VersionMetadata = ReturnType<typeof ensureVersions>

type BuildResult = {
  image: string
  digest: string
}

type ImageBuildConfig = {
  registry: string
  repository: string
  tag: string
  dockerfile: string
  context: string
  platforms: string[]
}

const resolveImageBuildConfig = ({ version }: VersionMetadata): ImageBuildConfig => {
  const registry = process.env.FROUSSARD_IMAGE_REGISTRY?.trim() || defaultRegistry
  const repository = process.env.FROUSSARD_IMAGE_REPOSITORY?.trim() || defaultRepository
  const tag = process.env.FROUSSARD_IMAGE_TAG?.trim() || sanitizeTag(version)
  const dockerfile = resolve(repoRoot, process.env.FROUSSARD_DOCKERFILE?.trim() || defaultDockerfile)
  const context = resolve(repoRoot, process.env.FROUSSARD_BUILD_CONTEXT?.trim() || defaultContext)
  const platforms = (process.env.FROUSSARD_PLATFORMS ?? defaultPlatforms.join(','))
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)

  return {
    registry,
    repository,
    tag,
    dockerfile,
    context,
    platforms: platforms.length > 0 ? platforms : defaultPlatforms,
  }
}

const buildFroussardImage = async (
  config: ImageBuildConfig,
  { version, commit }: VersionMetadata,
): Promise<BuildResult> => {
  console.log(`Building image ${config.registry}/${config.repository}:${config.tag}`)

  const result = await buildAndPushDockerImage({
    registry: config.registry,
    repository: config.repository,
    tag: config.tag,
    dockerfile: config.dockerfile,
    context: config.context,
    platforms: config.platforms,
    buildArgs: {
      FROUSSARD_VERSION: version,
      FROUSSARD_COMMIT: commit,
    },
  })

  const digest = inspectImageDigest(result.image)
  console.log(`Published ${result.image} (${digest})`)

  return { image: result.image, digest }
}

type ManifestUpdateOptions = {
  manifestPath: string
  imageDigest: string
  version: string
  commit: string
}

const updateKnativeServiceManifest = async (options: ManifestUpdateOptions) => {
  const manifestAbsolutePath = resolve(repoRoot, options.manifestPath)
  const manifestRelativePath = relative(repoRoot, manifestAbsolutePath)
  const YAML = await import('yaml')
  const current = await Bun.file(manifestAbsolutePath).text()
  const document = YAML.parse(current)

  const container = document?.spec?.template?.spec?.containers?.[0]
  if (!container || typeof container !== 'object') {
    throw new Error('Unable to locate primary container spec in Knative manifest')
  }

  container.image = options.imageDigest

  const env: Array<{ name: string; value?: string; valueFrom?: unknown }> = Array.isArray(container.env)
    ? container.env
    : []
  setEnvValue(env, 'FROUSSARD_VERSION', options.version)
  setEnvValue(env, 'FROUSSARD_COMMIT', options.commit)
  container.env = env

  const manifestYaml = `---\n${YAML.stringify(document, { lineWidth: 120 })}`
  await Bun.write(manifestAbsolutePath, manifestYaml)

  console.log(`Updated ${manifestRelativePath} with image ${options.imageDigest}`)
  return manifestAbsolutePath
}

const setEnvValue = (
  env: Array<{ name: string; value?: string; valueFrom?: unknown }>,
  name: string,
  value: string,
) => {
  const existing = env.find((entry) => entry && typeof entry === 'object' && entry.name === name)
  if (existing) {
    existing.value = value
    if ('valueFrom' in existing) {
      delete (existing as { valueFrom?: unknown }).valueFrom
    }
    return
  }

  env.push({ name, value })
}

export const main = async () => {
  const { dryRun } = parseArguments()

  if (dryRun) {
    console.log('Running in dry-run mode; skipping Docker push and kubectl apply.')
  } else {
    ensureCli('docker')
    ensureCli('kubectl')
  }

  const manifestPath = process.env.FROUSSARD_KNATIVE_MANIFEST?.trim() || defaultManifestPath

  const { version, commit } = ensureVersions()
  const imageConfig = resolveImageBuildConfig({ version, commit })
  console.log(`Deploying froussard version ${version} (${commit})`)

  let digest: string
  if (dryRun) {
    const imageReference = `${imageConfig.registry}/${imageConfig.repository}:${imageConfig.tag}`
    console.log(`[dry-run] Would build and push ${imageReference}`)
    digest = `${imageConfig.registry}/${imageConfig.repository}@sha256:dry-run`
  } else {
    ;({ digest } = await buildFroussardImage(imageConfig, { version, commit }))
  }

  const manifestAbsolutePath = await updateKnativeServiceManifest({
    manifestPath,
    imageDigest: digest,
    version,
    commit,
  })

  if (dryRun) {
    console.log(`[dry-run] Would apply ${manifestAbsolutePath} via kubectl`)
  } else {
    await run('kubectl', ['apply', '-f', manifestAbsolutePath], { cwd: repoRoot })
    console.log('Deployment applied via kubectl. Remember to commit the manifest update.')
  }
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to build and deploy froussard', error))
}

export const __private = {
  parseArguments,
  ensureVersions,
  resolveImageBuildConfig,
  buildFroussardImage,
  updateKnativeServiceManifest,
}
