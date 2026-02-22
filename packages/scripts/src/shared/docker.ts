import { ensureCli, repoRoot, run } from './cli'

export type DockerCacheMode = 'max' | 'min'

export type DockerBuildOptions = {
  registry: string
  repository: string
  tag: string
  context: string
  dockerfile: string
  target?: string
  buildArgs?: Record<string, string>
  noCache?: boolean
  cwd?: string
  platforms?: string[]
  codexAuthPath?: string
  cacheRef?: string
  cacheMode?: DockerCacheMode
  useBuildx?: boolean
}

export type DockerBuildResult = DockerBuildOptions & {
  image: string
}

type SpawnSync = typeof Bun.spawnSync

let spawnSyncImpl: SpawnSync = Bun.spawnSync

const isTruthyEnv = (value: string | undefined): boolean => {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return (
    normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'y' || normalized === 'on'
  )
}

const normalizeCacheMode = (value: string | undefined): DockerCacheMode => {
  if (!value) return 'max'
  const normalized = value.trim().toLowerCase()
  return normalized === 'min' ? 'min' : 'max'
}

export const buildAndPushDockerImage = async (options: DockerBuildOptions): Promise<DockerBuildResult> => {
  ensureCli('docker')

  const image = `${options.registry}/${options.repository}:${options.tag}`
  const cwd = options.cwd ?? repoRoot
  const ghTokenEnv = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  const dockerEnv = { DOCKER_BUILDKIT: process.env.DOCKER_BUILDKIT ?? '1' }
  const noCache = options.noCache ?? (isTruthyEnv(process.env.DOCKER_NO_CACHE) || isTruthyEnv(process.env.NO_CACHE))
  const cacheMode = normalizeCacheMode(options.cacheMode ?? process.env.DOCKER_BUILD_CACHE_MODE)

  let shouldUseBuildx =
    options.useBuildx === true || Boolean(options.cacheRef) || (options.platforms && options.platforms.length > 0)
  if (shouldUseBuildx && !isDockerBuildxAvailable()) {
    console.warn('docker buildx is unavailable; falling back to docker build + docker push (no remote cache).')
    shouldUseBuildx = false
  }

  let effectiveCacheRef = options.cacheRef
  let buildxDriver: string | undefined
  if (shouldUseBuildx && effectiveCacheRef) {
    buildxDriver = getDockerBuildxDriver()
    if (buildxDriver === 'docker' && !isTruthyEnv(process.env.DOCKER_BUILDX_ALLOW_DOCKER_DRIVER_CACHE)) {
      console.warn(
        'docker buildx is using the docker driver; registry cache export is unsupported. Skipping remote cache.',
      )
      effectiveCacheRef = undefined
    }
  }

  if (
    shouldUseBuildx &&
    !options.useBuildx &&
    (!options.platforms || options.platforms.length === 0) &&
    !effectiveCacheRef
  ) {
    shouldUseBuildx = false
  }

  console.log('Building Docker image with configuration:', {
    image,
    context: options.context,
    dockerfile: options.dockerfile,
    platforms: options.platforms && options.platforms.length > 0 ? options.platforms : undefined,
    buildArgs: Object.keys(options.buildArgs ?? {}).length ? options.buildArgs : undefined,
    noCache: noCache || undefined,
    cacheRef: effectiveCacheRef,
    cacheMode: effectiveCacheRef ? cacheMode : undefined,
    buildxDriver: buildxDriver ?? undefined,
    useBuildx: shouldUseBuildx || undefined,
  })

  if (shouldUseBuildx) {
    const args = ['buildx', 'build', '--push', '-f', options.dockerfile, '-t', image]
    if (options.target) args.push('--target', options.target)
    if (noCache) args.push('--no-cache')
    if (options.platforms && options.platforms.length > 0) {
      args.push('--platform', options.platforms.join(','))
    }
    if (effectiveCacheRef) {
      args.push('--cache-from', `type=registry,ref=${effectiveCacheRef}`)
      args.push('--cache-to', `type=registry,ref=${effectiveCacheRef},mode=${cacheMode}`)
    }
    if (options.codexAuthPath) {
      args.push('--secret', `id=codexauth,src=${options.codexAuthPath}`)
    }
    if (ghTokenEnv) {
      args.push('--secret', 'id=github_token,env=GH_TOKEN')
    }
    for (const [key, value] of Object.entries(options.buildArgs ?? {})) {
      args.push('--build-arg', `${key}=${value}`)
    }
    args.push(options.context)
    await run('docker', args, { cwd, env: dockerEnv })
  } else {
    const args = ['build', '-f', options.dockerfile, '-t', image]
    if (options.target) args.push('--target', options.target)
    if (noCache) args.push('--no-cache')
    if (options.codexAuthPath) {
      args.push('--secret', `id=codexauth,src=${options.codexAuthPath}`)
    }
    if (ghTokenEnv) {
      args.push('--secret', 'id=github_token,env=GH_TOKEN')
    }
    for (const [key, value] of Object.entries(options.buildArgs ?? {})) {
      args.push('--build-arg', `${key}=${value}`)
    }
    args.push(options.context)
    await run('docker', args, { cwd, env: dockerEnv })
    await run('docker', ['push', image], { cwd, env: dockerEnv })
  }

  return { ...options, image }
}

const isDockerBuildxAvailable = (): boolean => {
  const probe = spawnSyncImpl(['docker', 'buildx', 'version'], { cwd: repoRoot })
  return probe.exitCode === 0
}

const getDockerBuildxDriver = (): string | undefined => {
  const inspect = spawnSyncImpl(['docker', 'buildx', 'inspect'], { cwd: repoRoot })
  if (inspect.exitCode !== 0) {
    return undefined
  }

  const output = inspect.stdout.toString()
  const match = output.match(/^Driver:\s+(\S+)/m)
  return match?.[1]
}

export const inspectImageDigest = (image: string): string => {
  ensureCli('docker')
  const repoDigest = inspectLocalImageDigest(image)
  if (repoDigest) {
    return repoDigest
  }

  const remoteDigest = inspectRemoteImageDigest(image)
  if (remoteDigest) {
    return remoteDigest
  }

  throw new Error(`Unable to determine digest for image ${image}`)
}

export const inspectImageDigestForPlatform = (image: string, platform: string): string | undefined => {
  ensureCli('docker')
  const inspect = spawnSyncImpl(['docker', 'buildx', 'imagetools', 'inspect', '--format', '{{json .}}', image], {
    cwd: repoRoot,
  })

  if (inspect.exitCode !== 0) {
    return undefined
  }

  try {
    const parsed = JSON.parse(inspect.stdout.toString()) as {
      manifest?: {
        manifests?: Array<{
          digest?: string
          platform?: { os?: string; architecture?: string; variant?: string }
        }>
      }
    }
    const target = parsePlatform(platform)
    if (!target) {
      return undefined
    }

    const manifest = parsed.manifest?.manifests?.find((entry) => {
      const entryPlatform = entry.platform
      if (!entryPlatform) return false
      if (entryPlatform.os !== target.os) return false
      if (entryPlatform.architecture !== target.architecture) return false
      if (target.variant && entryPlatform.variant && entryPlatform.variant !== target.variant) return false
      if (target.variant && !entryPlatform.variant) return false
      return true
    })

    const digest = manifest?.digest?.trim()
    if (!digest) {
      return undefined
    }
    const repository = getRepositoryFromReference(image)
    return `${repository}@${digest}`
  } catch (error) {
    console.error('Failed to parse docker imagetools inspect output', error)
    return undefined
  }
}

const inspectLocalImageDigest = (image: string): string | undefined => {
  const inspect = spawnSyncImpl(['docker', 'image', 'inspect', '--format', '{{json .RepoDigests}}', image], {
    cwd: repoRoot,
  })

  if (inspect.exitCode !== 0) {
    return undefined
  }

  try {
    const digests = JSON.parse(inspect.stdout.toString()) as string[] | undefined
    if (!digests || digests.length === 0) {
      return undefined
    }

    const repository = getRepositoryFromReference(image)
    const match = digests.find((digest) => digest.startsWith(`${repository}@`))
    return match ?? digests[0]
  } catch {
    return undefined
  }
}

const inspectRemoteImageDigest = (image: string): string | undefined => {
  const inspect = spawnSyncImpl(
    ['docker', 'buildx', 'imagetools', 'inspect', '--format', '{{json .Manifest}}', image],
    { cwd: repoRoot },
  )

  if (inspect.exitCode !== 0) {
    return undefined
  }

  try {
    const parsed = JSON.parse(inspect.stdout.toString()) as { digest?: string } | undefined
    const digest = parsed?.digest?.trim()
    if (!digest) {
      return undefined
    }
    const repository = getRepositoryFromReference(image)
    return `${repository}@${digest}`
  } catch (error) {
    console.error('Failed to parse docker imagetools inspect output', error)
    return undefined
  }
}

const getRepositoryFromReference = (reference: string): string => {
  const digestIndex = reference.indexOf('@')
  const withoutDigest = digestIndex >= 0 ? reference.slice(0, digestIndex) : reference

  const lastSlash = withoutDigest.lastIndexOf('/')
  const lastColon = withoutDigest.lastIndexOf(':')

  if (lastColon > lastSlash) {
    return withoutDigest.slice(0, lastColon)
  }

  return withoutDigest
}

const parsePlatform = (platform: string): { os: string; architecture: string; variant?: string } | undefined => {
  const cleaned = platform.trim()
  if (!cleaned) {
    return undefined
  }

  const parts = cleaned.split('/')
  if (parts.length < 2) {
    return undefined
  }

  const [os, architecture, variant] = parts
  if (!os || !architecture) {
    return undefined
  }

  return { os, architecture, variant }
}

const setSpawnSync = (fn?: SpawnSync) => {
  spawnSyncImpl = fn ?? Bun.spawnSync
}

export const __private = {
  inspectLocalImageDigest,
  inspectRemoteImageDigest,
  getRepositoryFromReference,
  setSpawnSync,
}
