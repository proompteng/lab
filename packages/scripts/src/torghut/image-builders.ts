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

export type BuildImageResult = {
  image: string
  digest: string
  version: string
  commit: string
}

type TorghutImageVariant = 'core' | 'ws' | 'ta' | 'hyperliquid-feed' | 'notebook'

type TorghutImageConfig = {
  service: string
  imageName: string
  packageAttr: string
  repository: string
  envPrefix: string
  defaultTag: string
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

const imageConfigs: Record<TorghutImageVariant, TorghutImageConfig> = {
  core: {
    service: 'torghut',
    imageName: 'torghut',
    packageAttr: 'torghut-image',
    repository: 'lab/torghut',
    envPrefix: 'TORGHUT_IMAGE',
    defaultTag: 'latest',
  },
  ws: {
    service: 'torghut-ws',
    imageName: 'torghut-ws',
    packageAttr: 'torghut-ws-image',
    repository: 'lab/torghut-ws',
    envPrefix: 'TORGHUT_WS_IMAGE',
    defaultTag: 'latest',
  },
  ta: {
    service: 'torghut-ta',
    imageName: 'torghut-ta',
    packageAttr: 'torghut-ta-image',
    repository: 'lab/torghut-ta',
    envPrefix: 'TORGHUT_TA_IMAGE',
    defaultTag: 'latest',
  },
  'hyperliquid-feed': {
    service: 'torghut-hyperliquid-feed',
    imageName: 'torghut-hyperliquid-feed',
    packageAttr: 'torghut-hyperliquid-feed-image',
    repository: 'lab/torghut-hyperliquid-feed',
    envPrefix: 'TORGHUT_HYPERLIQUID_FEED_IMAGE',
    defaultTag: 'latest',
  },
  notebook: {
    service: 'torghut-notebook',
    imageName: 'torghut-notebook',
    packageAttr: 'torghut-notebook-image',
    repository: 'lab/torghut-notebook',
    envPrefix: 'TORGHUT_NOTEBOOK_IMAGE',
    defaultTag: 'latest',
  },
}

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

const rejectDockerOptions = (variant: TorghutImageVariant, options: BuildImageOptions): void => {
  const present = dockerOnlyOptionNames.filter((name) => options[name] !== undefined)
  if (present.length > 0) {
    throw new Error(`Torghut ${variant} Nix image builds do not accept Docker-only option(s): ${present.join(', ')}`)
  }
}

export const parseBuildImageArgs = (args: string[]): BuildImageOptions => {
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

const resolveBuildConfiguration = (
  variant: TorghutImageVariant,
  options: BuildImageOptions = {},
): BuildConfiguration => {
  rejectDockerOptions(variant, options)

  const config = imageConfigs[variant]
  const version = options.version ?? readEnv('TORGHUT_VERSION') ?? execGitImpl(['describe', '--tags', '--always'])
  const commit = options.commit ?? readEnv('TORGHUT_COMMIT') ?? execGitImpl(['rev-parse', 'HEAD'])
  const tag = options.tag ?? readEnv(`${config.envPrefix}_TAG`) ?? sanitizeTag(config.defaultTag)

  return {
    registry: options.registry ?? readEnv(`${config.envPrefix}_REGISTRY`) ?? 'registry.ide-newton.ts.net',
    repository: options.repository ?? readEnv(`${config.envPrefix}_REPOSITORY`) ?? config.repository,
    tag,
    version,
    commit,
    dryRun: options.dryRun,
  }
}

export const buildTorghutImage = async (
  variant: TorghutImageVariant,
  options: BuildImageOptions = {},
): Promise<BuildImageResult> => {
  const imageConfig = imageConfigs[variant]
  const buildConfig = resolveBuildConfiguration(variant, options)
  const result = await buildAndPushNixImageImpl({
    service: imageConfig.service,
    imageName: imageConfig.imageName,
    packageAttr: imageConfig.packageAttr,
    registry: buildConfig.registry,
    repository: buildConfig.repository,
    tag: buildConfig.tag,
    sourceSha: buildConfig.commit,
    latestTag: 'latest',
    dryRun: buildConfig.dryRun,
  })

  return {
    image: `${buildConfig.registry}/${buildConfig.repository}:${buildConfig.tag}`,
    digest: result.reference,
    version: buildConfig.version,
    commit: buildConfig.commit,
  }
}

export const __private = {
  parseBuildImageArgs,
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
