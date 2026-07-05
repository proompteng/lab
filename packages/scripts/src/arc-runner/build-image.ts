#!/usr/bin/env bun

import { buildAndPushNixImage } from '../shared/nix-oci-deploy'
import { execGit } from '../shared/git'

export type BuildImageOptions = {
  registry?: string
  repository?: string
  tag?: string
  version?: string
  commit?: string
  dryRun?: boolean
}

const readEnv = (name: string) => process.env[name]?.trim()

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

  const result = await buildAndPushNixImage({
    service: 'arc-runner',
    imageName: 'arc-runner',
    packageAttr: 'arc-runner-image',
    registry,
    repository,
    tag,
    sourceSha: commit,
    latestTag: 'latest',
    dryRun: options.dryRun,
    contractPath: '.artifacts/arc-runner/manual-release-contract.json',
  })

  return { image: `${registry}/${repository}:${tag}`, digest: result.reference, version, commit }
}

if (import.meta.main) {
  buildImage(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

export const __private = {
  parseArgs,
}
