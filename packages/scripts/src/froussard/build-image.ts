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

const sanitizeTag = (value: string) => {
  const normalized = value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return normalized.length > 0 ? normalized : 'latest'
}

const rejectDockerOptions = (options: BuildImageOptions): void => {
  const present = dockerOnlyOptionNames.filter((name) => options[name] !== undefined)
  if (present.length > 0) {
    throw new Error(`Froussard Nix image builds do not accept Docker-only option(s): ${present.join(', ')}`)
  }
}

const requireOptionValue = (args: string[], index: number, optionName: string): string => {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('-')) {
    throw new Error(`Missing value for ${optionName}`)
  }
  return value
}

const parsePlatforms = (value: string): string[] =>
  value
    .split(',')
    .map((platform) => platform.trim())
    .filter(Boolean)

const resolveBuildConfiguration = (options: BuildImageOptions = {}): BuildConfiguration => {
  rejectDockerOptions(options)

  const registry = options.registry ?? readEnv('FROUSSARD_IMAGE_REGISTRY') ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? readEnv('FROUSSARD_IMAGE_REPOSITORY') ?? 'lab/froussard'
  const version = options.version ?? readEnv('FROUSSARD_VERSION') ?? execGitImpl(['describe', '--tags', '--always'])
  const commit = options.commit ?? readEnv('FROUSSARD_COMMIT') ?? execGitImpl(['rev-parse', 'HEAD'])
  const tag = options.tag ?? readEnv('FROUSSARD_IMAGE_TAG') ?? sanitizeTag(version)

  return { registry, repository, tag, version, commit, dryRun: options.dryRun }
}

const parseArgs = (args: string[]): BuildImageOptions => {
  const options: BuildImageOptions = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg) continue

    if (arg === '--tag') {
      options.tag = requireOptionValue(args, index, arg)
      index += 1
      continue
    }
    if (arg.startsWith('--tag=')) {
      options.tag = arg.slice('--tag='.length)
      continue
    }
    if (arg === '--repository') {
      options.repository = requireOptionValue(args, index, arg)
      index += 1
      continue
    }
    if (arg.startsWith('--repository=')) {
      options.repository = arg.slice('--repository='.length)
      continue
    }
    if (arg === '--registry') {
      options.registry = requireOptionValue(args, index, arg)
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
    if (arg === '--context') {
      options.context = requireOptionValue(args, index, arg)
      index += 1
      continue
    }
    if (arg.startsWith('--context=')) {
      options.context = arg.slice('--context='.length)
      continue
    }
    if (arg === '--dockerfile') {
      options.dockerfile = requireOptionValue(args, index, arg)
      index += 1
      continue
    }
    if (arg.startsWith('--dockerfile=')) {
      options.dockerfile = arg.slice('--dockerfile='.length)
      continue
    }
    if (arg === '--platforms') {
      options.platforms = parsePlatforms(requireOptionValue(args, index, arg))
      index += 1
      continue
    }
    if (arg.startsWith('--platforms=')) {
      options.platforms = parsePlatforms(arg.slice('--platforms='.length))
      continue
    }
    if (arg === '--cache-ref') {
      options.cacheRef = requireOptionValue(args, index, arg)
      index += 1
      continue
    }
    if (arg.startsWith('--cache-ref=')) {
      options.cacheRef = arg.slice('--cache-ref='.length)
      continue
    }
    if (arg.startsWith('-')) {
      const optionName = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg
      throw new Error(`Unknown option: ${optionName}`)
    }
    if (!arg.startsWith('-') && options.tag === undefined) {
      options.tag = arg
      continue
    }

    throw new Error(`Unexpected positional argument: ${arg}`)
  }
  return options
}

export const buildImage = async (options: BuildImageOptions = {}) => {
  const config = resolveBuildConfiguration(options)
  const result = await buildAndPushNixImageImpl({
    service: 'froussard',
    imageName: 'froussard',
    packageAttr: 'froussard-image',
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
  sanitizeTag,
  setBuildAndPushNixImage: (impl: typeof buildAndPushNixImage = buildAndPushNixImage) => {
    buildAndPushNixImageImpl = impl
  },
  setExecGit: (impl: typeof execGit = execGit) => {
    execGitImpl = impl
  },
}
