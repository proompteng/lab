#!/usr/bin/env bun

import { buildAndPushNixImage } from '../shared/nix-oci-deploy'
import { execGit } from '../shared/git'

export type AgentsImageTarget = 'controller' | 'control-plane' | 'agents-shell' | 'runner'

export type BuildImageOptions = {
  registry?: string
  repository?: string
  tag?: string
  target?: string
  version?: string
  commit?: string
  dryRun?: boolean
  context?: string
  dockerfile?: string
  codexAuthPath?: string
  cacheRef?: string
  platforms?: string[]
  cacheMode?: string
}

type BuildConfiguration = {
  registry: string
  repository: string
  tag: string
  version: string
  commit: string
  target: AgentsImageTarget
  service: string
  imageName: string
  packageAttr: string
  dryRun?: boolean
}

type AgentsImagePlan = {
  target: AgentsImageTarget
  aliases: string[]
  service: string
  imageName: string
  packageAttr: string
  defaultRepository: string
  repositoryEnvKeys: string[]
}

const imagePlans: AgentsImagePlan[] = [
  {
    target: 'controller',
    aliases: ['controller', 'agents-controller'],
    service: 'agents-controller',
    imageName: 'agents-controller',
    packageAttr: 'agents-controller-image',
    defaultRepository: 'lab/agents-controller',
    repositoryEnvKeys: ['AGENTS_CONTROLLER_IMAGE_REPOSITORY', 'AGENTS_IMAGE_REPOSITORY'],
  },
  {
    target: 'control-plane',
    aliases: ['control-plane', 'controlplane', 'agents-control-plane', 'agents'],
    service: 'agents-control-plane',
    imageName: 'agents-control-plane',
    packageAttr: 'agents-control-plane-image',
    defaultRepository: 'lab/agents-control-plane',
    repositoryEnvKeys: ['AGENTS_CONTROL_PLANE_IMAGE_REPOSITORY', 'AGENTS_IMAGE_REPOSITORY'],
  },
  {
    target: 'agents-shell',
    aliases: ['agents-shell', 'shell'],
    service: 'agents-shell',
    imageName: 'agents-shell',
    packageAttr: 'agents-shell-image',
    defaultRepository: 'lab/agents-shell',
    repositoryEnvKeys: ['AGENTS_SHELL_IMAGE_REPOSITORY'],
  },
  {
    target: 'runner',
    aliases: ['runner', 'codex-runner', 'agents-codex-runner'],
    service: 'agents-codex-runner',
    imageName: 'agents-codex-runner',
    packageAttr: 'agents-codex-runner-image',
    defaultRepository: 'lab/agents-codex-runner',
    repositoryEnvKeys: ['AGENTS_RUNNER_IMAGE_REPOSITORY'],
  },
]

const planByTarget = new Map(imagePlans.map((plan) => [plan.target, plan] as const))
const targetByAlias = new Map(imagePlans.flatMap((plan) => plan.aliases.map((alias) => [alias, plan.target] as const)))
const targetByRepository = new Map(
  imagePlans.map((plan) => [plan.defaultRepository.replace(/^lab\//, ''), plan.target] as const),
)

const dockerOnlyOptionNames = ['context', 'dockerfile', 'codexAuthPath', 'cacheRef', 'platforms', 'cacheMode'] as const

let buildAndPushNixImageImpl = buildAndPushNixImage
let execGitImpl = execGit

const readEnv = (name: string) => process.env[name]?.trim()

const resolveTarget = (value: string | undefined, fallback: AgentsImageTarget): AgentsImageTarget => {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return fallback

  const target = targetByAlias.get(normalized)
  if (target) return target

  throw new Error(`Unsupported Agents image target: ${value}`)
}

const inferTargetFromRepository = (repository: string | undefined): AgentsImageTarget | undefined => {
  const normalized = repository
    ?.trim()
    .replace(/^registry\.ide-newton\.ts\.net\//, '')
    .replace(/^lab\//, '')
  if (!normalized) return undefined
  return targetByRepository.get(normalized)
}

const rejectDockerOptions = (options: BuildImageOptions): void => {
  const present = dockerOnlyOptionNames.filter((name) => options[name] !== undefined)
  if (present.length > 0) {
    throw new Error(`Agents Nix image builds do not accept Docker-only option(s): ${present.join(', ')}`)
  }
}

const resolveRepository = (plan: AgentsImagePlan, explicitRepository: string | undefined): string => {
  if (explicitRepository?.trim()) return explicitRepository.trim()

  for (const key of plan.repositoryEnvKeys) {
    const value = readEnv(key)
    if (value) return value
  }

  return plan.defaultRepository
}

const resolveBuildConfiguration = (options: BuildImageOptions = {}): BuildConfiguration => {
  rejectDockerOptions(options)

  const registry = options.registry ?? readEnv('AGENTS_IMAGE_REGISTRY') ?? 'registry.ide-newton.ts.net'
  const explicitTarget = options.target ?? readEnv('AGENTS_IMAGE_TARGET') ?? readEnv('AGENTS_NIX_IMAGE_TARGET')
  const repositoryTarget = inferTargetFromRepository(options.repository ?? readEnv('AGENTS_IMAGE_REPOSITORY'))
  const target = explicitTarget ? resolveTarget(explicitTarget, 'control-plane') : (repositoryTarget ?? 'control-plane')
  const plan = planByTarget.get(target)
  if (!plan) throw new Error(`Unsupported Agents image target: ${target}`)

  const repository = resolveRepository(plan, options.repository)
  const tag = options.tag ?? readEnv('AGENTS_IMAGE_TAG') ?? execGitImpl(['rev-parse', '--short', 'HEAD'])
  const version = options.version ?? readEnv('AGENTS_VERSION') ?? tag
  const commit = options.commit ?? readEnv('AGENTS_COMMIT') ?? execGitImpl(['rev-parse', 'HEAD'])

  return {
    registry,
    repository,
    tag,
    version,
    commit,
    target,
    service: plan.service,
    imageName: plan.imageName,
    packageAttr: plan.packageAttr,
    dryRun: options.dryRun,
  }
}

export const buildImage = async (options: BuildImageOptions = {}) => {
  const config = resolveBuildConfiguration(options)
  const result = await buildAndPushNixImageImpl({
    service: config.service,
    imageName: config.imageName,
    packageAttr: config.packageAttr,
    registry: config.registry,
    repository: config.repository,
    tag: config.tag,
    sourceSha: config.commit,
    latestTag: 'latest',
    dryRun: config.dryRun,
    contractPath: `.artifacts/agents/${config.service}-manual-release-contract.json`,
  })

  return {
    image: `${config.registry}/${config.repository}:${config.tag}`,
    digest: result.reference,
    version: config.version,
    commit: config.commit,
    target: config.target,
    packageAttr: config.packageAttr,
  }
}

export const buildImages = async (options: BuildImageOptions[]) => {
  const results = []
  for (const option of options) {
    results.push(await buildImage(option))
  }
  return results
}

const parseArgs = (args: string[]): BuildImageOptions => {
  const options: BuildImageOptions = {}
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg) continue

    if (arg === '--target') {
      options.target = args[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--target=')) {
      options.target = arg.slice('--target='.length)
      continue
    }
    if (arg === '--tag') {
      options.tag = args[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--tag=')) {
      options.tag = arg.slice('--tag='.length)
      continue
    }
    if (arg === '--repository') {
      options.repository = args[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--repository=')) {
      options.repository = arg.slice('--repository='.length)
      continue
    }
    if (arg === '--registry') {
      options.registry = args[i + 1]
      i += 1
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

if (import.meta.main) {
  buildImage(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

export const __private = {
  execGit,
  inferTargetFromRepository,
  parseArgs,
  rejectDockerOptions,
  resolveBuildConfiguration,
  resolveTarget,
  setBuildAndPushNixImage: (impl: typeof buildAndPushNixImage = buildAndPushNixImage) => {
    buildAndPushNixImageImpl = impl
  },
  setExecGit: (impl: typeof execGit = execGit) => {
    execGitImpl = impl
  },
}
