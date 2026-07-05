#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { ensureCli, fatal, repoRoot, run } from '../shared/cli'
import { execGit } from '../shared/git'
import { buildImage } from './build-image'

type CliOptions = {
  dryRun: boolean
  apply: boolean
  registry?: string
  repository?: string
  tag?: string
  applicationPath: string
}

const defaultApplicationPath = 'argocd/applications/arc/application.yaml'
const requiredArcRunnerPlatforms = ['linux/amd64', 'linux/arm64'] as const
const arcRunnerImagePattern =
  /(\bimage:\s+)registry\.ide-newton\.ts\.net\/lab\/arc-runner(?::[A-Za-z0-9._-]+|@sha256:[0-9a-f]{64})/g

const readEnv = (name: string) => process.env[name]?.trim()

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
    if (arg === '--application-path') {
      options.applicationPath = argv[index + 1]
      index += 1
      continue
    }
    if (arg.startsWith('--application-path=')) {
      options.applicationPath = arg.slice('--application-path='.length)
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
  const dryRun = parsed.dryRun ?? readEnv('ARC_RUNNER_DRY_RUN') === 'true'

  return {
    dryRun,
    apply: dryRun ? false : (parsed.apply ?? readEnv('ARC_RUNNER_NO_APPLY') !== 'true'),
    registry: parsed.registry ?? readEnv('ARC_RUNNER_IMAGE_REGISTRY') ?? 'registry.ide-newton.ts.net',
    repository: parsed.repository ?? readEnv('ARC_RUNNER_IMAGE_REPOSITORY') ?? 'lab/arc-runner',
    tag: parsed.tag ?? readEnv('ARC_RUNNER_IMAGE_TAG') ?? execGit(['rev-parse', '--short', 'HEAD']),
    applicationPath: parsed.applicationPath ?? readEnv('ARC_RUNNER_APPLICATION_PATH') ?? defaultApplicationPath,
  }
}

const assertArcRunnerDigest = (imageDigest: string): string => {
  const normalized = imageDigest.trim()
  if (!/^registry\.ide-newton\.ts\.net\/lab\/arc-runner@sha256:[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(
      `Expected ARC runner digest reference registry.ide-newton.ts.net/lab/arc-runner@sha256:<64 hex>, got ${imageDigest}`,
    )
  }
  return normalized
}

const assertArcRunnerDeployableImage = (imageResult: { digest: string; platforms?: readonly string[] }): string => {
  const imageReference = assertArcRunnerDigest(imageResult.digest)
  const platforms = imageResult.platforms ?? []
  const observed = new Set(platforms)
  const missing = requiredArcRunnerPlatforms.filter((platform) => !observed.has(platform))

  if (missing.length > 0) {
    const observedText = platforms.length > 0 ? [...platforms].sort().join(', ') : 'none'
    throw new Error(
      `ARC runner image ${imageReference} must be a multi-arch OCI index before updating manifests; missing required platform(s): ${missing.join(', ')}; observed: ${observedText}`,
    )
  }

  return imageReference
}

const updateArcRunnerImageManifests = (imageDigest: string, applicationPath = defaultApplicationPath): void => {
  const imageReference = assertArcRunnerDigest(imageDigest)
  const absolutePath = resolve(repoRoot, applicationPath)
  const current = readFileSync(absolutePath, 'utf8')
  let replacementCount = 0
  const updated = current.replace(arcRunnerImagePattern, (_match, prefix: string) => {
    replacementCount += 1
    return `${prefix}${imageReference}`
  })

  if (replacementCount !== 6) {
    throw new Error(`Expected 6 ARC runner image references in ${applicationPath}, found ${replacementCount}`)
  }
  if (!updated.includes('image: docker:dind')) {
    throw new Error(`${applicationPath} no longer contains the expected docker:dind sidecar reference`)
  }
  if (updated !== current) {
    writeFileSync(absolutePath, updated)
    console.log(`Updated ${applicationPath} with ${imageReference}`)
  }
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
  console.log(`Image platforms: ${imageResult.platforms.join(', ') || 'none'}`)

  if (options.dryRun) {
    console.log('Dry run complete; manifests and cluster state were not changed.')
    return
  }

  const imageReference = assertArcRunnerDeployableImage(imageResult)
  updateArcRunnerImageManifests(imageReference, options.applicationPath)

  if (!options.apply) {
    console.log('Skipping kubectl apply because --no-apply was requested.')
    return
  }

  await run('kubectl', ['apply', '-f', resolve(repoRoot, options.applicationPath)])
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to build and deploy ARC runner', error))
}

export const __private = {
  assertArcRunnerDeployableImage,
  assertArcRunnerDigest,
  parseArgs,
  resolveOptions,
  updateArcRunnerImageManifests,
}
