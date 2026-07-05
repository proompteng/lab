#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { BuildAndPushNixImageResult } from '../shared/nix-oci-deploy'
import { buildAndPushNixImage } from '../shared/nix-oci-deploy'
import { execGit } from '../shared/git'
import { createOciIndex, type OciArchTag, type OciPlatformDigest } from '../shared/oci'

export type BuildImageOptions = {
  registry?: string
  repository?: string
  tag?: string
  version?: string
  commit?: string
  dryRun?: boolean
}

const service = 'arc-runner'
const imageName = 'arc-runner'
const packageAttr = 'arc-runner-image'
const requiredPlatforms = ['linux/amd64', 'linux/arm64'] as const

const readEnv = (name: string) => process.env[name]?.trim()

const localPlatform = (): (typeof requiredPlatforms)[number] => {
  if (process.arch === 'x64') return 'linux/amd64'
  if (process.arch === 'arm64') return 'linux/arm64'
  throw new Error(`Unsupported ARC runner image build architecture: ${process.arch}`)
}

const platformSuffix = (platform: string): string => platform.replace(/^linux\//, '').replaceAll('/', '_')

const platformTag = (tag: string, platform: string): string => `${tag}-${platformSuffix(platform)}`

const platformIndexTags = (tag: string): OciArchTag[] =>
  requiredPlatforms.map((platform) => ({ platform, tag: platformTag(tag, platform) }))

const platformDigestRecord = (platformDigests: OciPlatformDigest[]): Record<string, string> =>
  Object.fromEntries(platformDigests.map((entry) => [entry.platform, entry.digest]))

const writeIndexReleaseContract = (
  platformResult: BuildAndPushNixImageResult,
  indexResult: {
    image: string
    tag: string
    digest: string
    reference: string
    platformDigests: OciPlatformDigest[]
  },
  sourceSha: string,
): void => {
  const platformDigests = platformDigestRecord(indexResult.platformDigests)
  mkdirSync(dirname(platformResult.contractPath), { recursive: true })
  writeFileSync(
    platformResult.contractPath,
    `${JSON.stringify(
      {
        service,
        image: indexResult.image,
        tag: indexResult.tag,
        digest: indexResult.digest,
        reference: indexResult.reference,
        sourceSha,
        packageAttr,
        platforms: indexResult.platformDigests.map((entry) => entry.platform),
        platformDigests,
        imageTarPath: platformResult.imageTarPath,
        platformTag: platformResult.tag,
        builder: 'nix-dockerTools-skopeo',
        invocation: 'manual-script',
      },
      null,
      2,
    )}\n`,
  )
}

const parseArgs = (args: string[]): BuildImageOptions => {
  const options: BuildImageOptions = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg) continue

    if (arg === '--tag') {
      options.tag = args[index + 1]
      index += 1
      continue
    }
    if (arg.startsWith('--tag=')) {
      options.tag = arg.slice('--tag='.length)
      continue
    }
    if (arg === '--repository') {
      options.repository = args[index + 1]
      index += 1
      continue
    }
    if (arg.startsWith('--repository=')) {
      options.repository = arg.slice('--repository='.length)
      continue
    }
    if (arg === '--registry') {
      options.registry = args[index + 1]
      index += 1
      continue
    }
    if (arg.startsWith('--registry=')) {
      options.registry = arg.slice('--registry='.length)
      continue
    }
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (!arg.startsWith('-') && options.tag === undefined) {
      options.tag = arg
    }
  }
  return options
}

export const buildImage = async (options: BuildImageOptions = {}) => {
  const registry = options.registry ?? readEnv('ARC_RUNNER_IMAGE_REGISTRY') ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? readEnv('ARC_RUNNER_IMAGE_REPOSITORY') ?? 'lab/arc-runner'
  const tag = options.tag ?? readEnv('ARC_RUNNER_IMAGE_TAG') ?? execGit(['rev-parse', '--short', 'HEAD'])
  const version = options.version ?? readEnv('ARC_RUNNER_VERSION') ?? execGit(['describe', '--tags', '--always'])
  const commit = options.commit ?? readEnv('ARC_RUNNER_COMMIT') ?? execGit(['rev-parse', 'HEAD'])
  const image = `${registry}/${repository}`

  if (options.dryRun) {
    const result = await buildAndPushNixImage({
      service,
      imageName,
      packageAttr,
      registry,
      repository,
      tag,
      sourceSha: commit,
      latestTag: 'latest',
      dryRun: true,
      contractPath: '.artifacts/arc-runner/manual-release-contract.json',
    })

    return {
      image: `${image}:${tag}`,
      digest: result.reference,
      version,
      commit,
      platforms: result.platforms,
      platformDigests: result.platformDigests,
    }
  }

  const buildPlatform = localPlatform()
  const localPlatformTag = platformTag(tag, buildPlatform)
  const result = await buildAndPushNixImage({
    service,
    imageName,
    packageAttr,
    registry,
    repository,
    tag: localPlatformTag,
    sourceSha: commit,
    contractPath: '.artifacts/arc-runner/manual-release-contract.json',
  })
  if (!result.platforms.includes(buildPlatform)) {
    throw new Error(
      `Local ARC runner image build produced ${result.platforms.join(', ') || 'no observable platform'}; expected ${buildPlatform}`,
    )
  }

  const indexResult = createOciIndex({ image, tag, latest: true, archTags: platformIndexTags(tag) })
  writeIndexReleaseContract(result, indexResult, commit)

  const platforms = indexResult.platformDigests.map((entry) => entry.platform)

  return {
    image: `${image}:${tag}`,
    digest: indexResult.reference,
    version,
    commit,
    platforms,
    platformDigests: platformDigestRecord(indexResult.platformDigests),
  }
}

if (import.meta.main) {
  buildImage(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

export const __private = {
  localPlatform,
  parseArgs,
  platformIndexTags,
  platformSuffix,
  platformTag,
}
