#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { ensureCli, fatal, repoRoot, run } from '../shared/cli'
import { execGit } from '../shared/git'
import { buildImage } from './build-image'

type CliOptions = {
  dryRun: boolean
  apply: boolean
  registry: string
  repository: string
  tag: string
  kustomizePath: string
  namespace: string
  deploymentName: string
}

type ManifestUpdateOptions = {
  imageDigest: string
  registry?: string
  repository?: string
  kustomizePath?: string
  deploymentPath?: string
  gcCronJobPath?: string
}

const defaultKustomizePath = 'argocd/applications/attic'
const defaultImageRegistry = 'registry.ide-newton.ts.net'
const defaultImageRepository = 'lab/attic'
const defaultImageName = `${defaultImageRegistry}/${defaultImageRepository}`
const requiredRuntimePlatforms = ['linux/amd64', 'linux/arm64'] as const
const digestPattern = /^sha256:[0-9a-f]{64}$/

const readEnv = (name: string) => process.env[name]?.trim()

const normalizeImagePart = (value: string, field: string): string => {
  const normalized = value.trim().replace(/^\/+|\/+$/g, '')
  if (!normalized) {
    throw new Error(`${field} is required`)
  }
  return normalized
}

const imageNameFor = (registry: string, repository: string): string =>
  `${normalizeImagePart(registry, 'registry')}/${normalizeImagePart(repository, 'repository')}`

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const atticImagePatternFor = (imageNames: string[]): RegExp => {
  const escapedImageNames = [...new Set(imageNames.map((name) => name.trim()).filter(Boolean))].map(escapeRegExp)
  if (escapedImageNames.length === 0) {
    throw new Error('At least one Attic image name is required')
  }
  return new RegExp(`(\\bimage:\\s+)(?:${escapedImageNames.join('|')})(?::[A-Za-z0-9._-]+|@sha256:[0-9a-f]{64})`, 'g')
}

const resolveKustomizeManifestPaths = (kustomizePath = defaultKustomizePath) => {
  const basePath = resolve(repoRoot, kustomizePath)
  return {
    deploymentPath: join(basePath, 'deployment.yaml'),
    gcCronJobPath: join(basePath, 'gc-cronjob.yaml'),
  }
}

const parseArgs = (argv: string[]): Partial<CliOptions> => {
  const options: Partial<CliOptions> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg) continue

    if (arg === '--dry-run') {
      options.dryRun = true
      options.apply = false
      continue
    }
    if (arg === '--no-apply') {
      options.apply = false
      continue
    }
    if (arg === '--tag') {
      options.tag = argv[index + 1]
      index += 1
      continue
    }
    if (arg.startsWith('--tag=')) {
      options.tag = arg.slice('--tag='.length)
      continue
    }
    if (arg === '--registry') {
      options.registry = argv[index + 1]
      index += 1
      continue
    }
    if (arg.startsWith('--registry=')) {
      options.registry = arg.slice('--registry='.length)
      continue
    }
    if (arg === '--repository') {
      options.repository = argv[index + 1]
      index += 1
      continue
    }
    if (arg.startsWith('--repository=')) {
      options.repository = arg.slice('--repository='.length)
      continue
    }
    if (arg === '--kustomize-path') {
      options.kustomizePath = argv[index + 1]
      index += 1
      continue
    }
    if (arg.startsWith('--kustomize-path=')) {
      options.kustomizePath = arg.slice('--kustomize-path='.length)
      continue
    }
    if (arg === '--namespace') {
      options.namespace = argv[index + 1]
      index += 1
      continue
    }
    if (arg.startsWith('--namespace=')) {
      options.namespace = arg.slice('--namespace='.length)
      continue
    }
    if (arg === '--deployment') {
      options.deploymentName = argv[index + 1]
      index += 1
      continue
    }
    if (arg.startsWith('--deployment=')) {
      options.deploymentName = arg.slice('--deployment='.length)
      continue
    }
    if (!arg.startsWith('-') && options.tag === undefined) {
      options.tag = arg
    }
  }
  return options
}

const resolveOptions = (argv = process.argv.slice(2)): CliOptions => {
  const parsed = parseArgs(argv)
  const dryRun = parsed.dryRun ?? readEnv('ATTIC_DRY_RUN') === 'true'

  return {
    dryRun,
    apply: dryRun ? false : (parsed.apply ?? readEnv('ATTIC_NO_APPLY') !== 'true'),
    registry: parsed.registry ?? readEnv('ATTIC_IMAGE_REGISTRY') ?? defaultImageRegistry,
    repository: parsed.repository ?? readEnv('ATTIC_IMAGE_REPOSITORY') ?? defaultImageRepository,
    tag: parsed.tag ?? readEnv('ATTIC_IMAGE_TAG') ?? execGit(['rev-parse', '--short', 'HEAD']),
    kustomizePath: parsed.kustomizePath ?? readEnv('ATTIC_KUSTOMIZE_PATH') ?? defaultKustomizePath,
    namespace: parsed.namespace ?? readEnv('ATTIC_K8S_NAMESPACE') ?? 'attic',
    deploymentName: parsed.deploymentName ?? readEnv('ATTIC_K8S_DEPLOYMENT') ?? 'attic',
  }
}

const assertAtticImageDigest = (imageDigest: string, imageName = defaultImageName): string => {
  const normalized = imageDigest.trim()
  const expectedPrefix = `${imageName}@`
  const digest = normalized.startsWith(expectedPrefix) ? normalized.slice(expectedPrefix.length) : ''
  if (!digestPattern.test(digest)) {
    throw new Error(`Expected Attic digest reference ${imageName}@sha256:<64 hex>, got ${imageDigest}`)
  }
  return normalized
}

const assertRequiredImagePlatforms = (
  platforms: string[],
  requiredPlatforms: readonly string[] = requiredRuntimePlatforms,
): string[] => {
  const observed = new Set(platforms.map((platform) => platform.trim()).filter(Boolean))
  const missing = requiredPlatforms.filter((platform) => !observed.has(platform))
  if (missing.length > 0) {
    const observedText = [...observed].sort().join(', ') || 'none'
    throw new Error(
      `Attic deployment image must include required platform(s) before manifests can be pinned: ${missing.join(', ')}; observed: ${observedText}`,
    )
  }
  return platforms
}

const updateImageReferences = (
  path: string,
  imageReference: string,
  expectedReferences: number,
  imageNames = [defaultImageName],
): void => {
  const current = readFileSync(path, 'utf8')
  let replacementCount = 0
  const atticImagePattern = atticImagePatternFor(imageNames)
  const updated = current.replace(atticImagePattern, (_match, prefix: string) => {
    replacementCount += 1
    return `${prefix}${imageReference}`
  })

  if (replacementCount !== expectedReferences) {
    throw new Error(`Expected ${expectedReferences} Attic image reference(s) in ${path}, found ${replacementCount}`)
  }
  if (updated !== current) {
    writeFileSync(path, updated)
    console.log(`Updated ${path} with ${imageReference}`)
  }
}

const updateAtticImageManifests = (options: ManifestUpdateOptions): void => {
  const imageName = imageNameFor(options.registry ?? defaultImageRegistry, options.repository ?? defaultImageRepository)
  const imageReference = assertAtticImageDigest(options.imageDigest, imageName)
  const manifestPaths = resolveKustomizeManifestPaths(options.kustomizePath)
  const imageNames = imageName === defaultImageName ? [imageName] : [imageName, defaultImageName]
  updateImageReferences(
    resolve(repoRoot, options.deploymentPath ?? manifestPaths.deploymentPath),
    imageReference,
    2,
    imageNames,
  )
  updateImageReferences(
    resolve(repoRoot, options.gcCronJobPath ?? manifestPaths.gcCronJobPath),
    imageReference,
    1,
    imageNames,
  )
}

export const main = async (argv = process.argv.slice(2)) => {
  const options = resolveOptions(argv)

  if (options.apply) {
    ensureCli('kubectl')
  }

  const imageResult = await buildImage({
    registry: options.registry,
    repository: options.repository,
    tag: options.tag,
    dryRun: options.dryRun,
  })
  console.log(`Image digest: ${imageResult.digest}`)

  if (options.dryRun) {
    console.log('Dry run complete; manifests and cluster state were not changed.')
    return
  }

  assertRequiredImagePlatforms(imageResult.platforms)
  updateAtticImageManifests({
    imageDigest: imageResult.digest,
    registry: options.registry,
    repository: options.repository,
    kustomizePath: options.kustomizePath,
  })

  if (!options.apply) {
    console.log('Skipping kubectl apply because --no-apply was requested.')
    return
  }

  const kustomizePath = resolve(repoRoot, options.kustomizePath)
  await run('kubectl', ['apply', '-k', kustomizePath])
  await run('kubectl', ['rollout', 'status', `deployment/${options.deploymentName}`, '-n', options.namespace])
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to build and deploy attic', error))
}

export const __private = {
  assertAtticImageDigest,
  assertRequiredImagePlatforms,
  imageNameFor,
  parseArgs,
  resolveOptions,
  resolveKustomizeManifestPaths,
  updateAtticImageManifests,
  updateImageReferences,
}
