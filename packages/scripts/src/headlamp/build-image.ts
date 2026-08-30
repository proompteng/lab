#!/usr/bin/env bun

import { execGit } from '../shared/git'
import { buildAndPushNixImage } from '../shared/nix-oci-deploy'

export type BuildImageOptions = {
  registry?: string
  repository?: string
  tag?: string
  version?: string
  commit?: string
  dryRun?: boolean
  context?: string
  dockerfile?: string
  platforms?: string[]
  cacheRef?: string
}

type BuildConfiguration = {
  registry: string
  repository: string
  tag: string
  version: string
  commit: string
  dryRun?: boolean
}

const dockerOnlyOptionNames = ['context', 'dockerfile', 'platforms', 'cacheRef'] as const

let buildAndPushNixImageImpl = buildAndPushNixImage
let execGitImpl = execGit

const readEnv = (name: string) => process.env[name]?.trim()

const rejectDockerOptions = (options: BuildImageOptions): void => {
  const present = dockerOnlyOptionNames.filter((name) => options[name] !== undefined)
  if (present.length > 0) {
    throw new Error(`Headlamp Nix image builds do not accept Docker-only option(s): ${present.join(', ')}`)
  }
}

const resolveBuildConfiguration = (options: BuildImageOptions = {}): BuildConfiguration => {
  rejectDockerOptions(options)

  const registry = options.registry ?? readEnv('HEADLAMP_IMAGE_REGISTRY') ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? readEnv('HEADLAMP_IMAGE_REPOSITORY') ?? 'lab/headlamp'
  const tag = options.tag ?? readEnv('HEADLAMP_IMAGE_TAG') ?? execGitImpl(['rev-parse', '--short', 'HEAD'])
  const version = options.version ?? readEnv('HEADLAMP_VERSION') ?? 'v0.40.1'
  const commit = options.commit ?? readEnv('HEADLAMP_COMMIT') ?? execGitImpl(['rev-parse', 'HEAD'])

  return { registry, repository, tag, version, commit, dryRun: options.dryRun }
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
  const config = resolveBuildConfiguration(options)
  const result = await buildAndPushNixImageImpl({
    service: 'headlamp',
    imageName: 'headlamp',
    packageAttr: 'headlamp-image',
    registry: config.registry,
    repository: config.repository,
    tag: config.tag,
    sourceSha: config.commit,
    latestTag: 'latest',
    dryRun: config.dryRun,
  })

  return {
    image: `${config.registry}/${config.repository}:${config.tag}`,
    digest: result.reference,
    version: config.version,
    commit: config.commit,
  }
}

if (import.meta.main) {
  buildImage(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

export const __private = {
  parseArgs,
  rejectDockerOptions,
  resolveBuildConfiguration,
  setBuildAndPushNixImage: (impl: typeof buildAndPushNixImage = buildAndPushNixImage) => {
    buildAndPushNixImageImpl = impl
  },
  setExecGit: (impl: typeof execGit = execGit) => {
    execGitImpl = impl
  },
}
