import { ensureCli, repoRoot, run } from './cli'

export type DockerBuildOptions = {
  registry: string
  repository: string
  tag: string
  context: string
  dockerfile: string
  buildArgs?: Record<string, string>
  cwd?: string
  platforms?: string[]
  codexAuthPath?: string
}

export type DockerBuildResult = DockerBuildOptions & {
  image: string
}

type SpawnSync = typeof Bun.spawnSync

let spawnSyncImpl: SpawnSync = (...args) => Bun.spawnSync(...args)

export const buildAndPushDockerImage = async (options: DockerBuildOptions): Promise<DockerBuildResult> => {
  ensureCli('docker')

  const image = `${options.registry}/${options.repository}:${options.tag}`
  const cwd = options.cwd ?? repoRoot
  const ghTokenEnv = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN

  console.log('Building Docker image with configuration:', {
    image,
    context: options.context,
    dockerfile: options.dockerfile,
    platforms: options.platforms && options.platforms.length > 0 ? options.platforms : undefined,
    buildArgs: Object.keys(options.buildArgs ?? {}).length ? options.buildArgs : undefined,
  })

  if (options.platforms && options.platforms.length > 0) {
    const args = ['buildx', 'build', '--push', '-f', options.dockerfile, '-t', image]
    args.push('--platform', options.platforms.join(','))
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
    await run('docker', args, { cwd })
  } else {
    const args = ['build', '-f', options.dockerfile, '-t', image]
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
    await run('docker', args, { cwd })
    await run('docker', ['push', image], { cwd })
  }

  return { ...options, image }
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

const inspectLocalImageDigest = (image: string): string | undefined => {
  const inspect = spawnSyncImpl(['docker', 'image', 'inspect', '--format', '{{index .RepoDigests 0}}', image], {
    cwd: repoRoot,
  })

  if (inspect.exitCode !== 0) {
    return undefined
  }

  const digest = inspect.stdout.toString().trim()
  return digest.length > 0 ? digest : undefined
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

const setSpawnSync = (fn?: SpawnSync) => {
  spawnSyncImpl = fn ?? ((...args) => Bun.spawnSync(...args))
}

export const __private = {
  inspectLocalImageDigest,
  inspectRemoteImageDigest,
  getRepositoryFromReference,
  setSpawnSync,
}
