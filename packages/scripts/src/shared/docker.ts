import { ensureCli, repoRoot, run } from './cli'

export type DockerBuildOptions = {
  registry: string
  repository: string
  tag: string
  context: string
  dockerfile: string
  buildArgs?: Record<string, string>
  cwd?: string
}

export type DockerBuildResult = DockerBuildOptions & {
  image: string
}

export const buildAndPushDockerImage = async (options: DockerBuildOptions): Promise<DockerBuildResult> => {
  ensureCli('docker')

  const image = `${options.registry}/${options.repository}:${options.tag}`
  const cwd = options.cwd ?? repoRoot

  console.log('Building Docker image with configuration:', {
    image,
    context: options.context,
    dockerfile: options.dockerfile,
    buildArgs: Object.keys(options.buildArgs ?? {}).length ? options.buildArgs : undefined,
  })

  const args = ['build', '-f', options.dockerfile, '-t', image]
  for (const [key, value] of Object.entries(options.buildArgs ?? {})) {
    args.push('--build-arg', `${key}=${value}`)
  }
  args.push(options.context)

  await run('docker', args, { cwd })
  await run('docker', ['push', image], { cwd })

  return { ...options, image }
}

export const inspectImageDigest = (image: string): string => {
  ensureCli('docker')
  const inspect = Bun.spawnSync(['docker', 'image', 'inspect', '--format', '{{index .RepoDigests 0}}', image], {
    cwd: repoRoot,
  })

  if (inspect.exitCode !== 0) {
    throw new Error(`docker image inspect ${image} failed: ${inspect.stderr.toString()}`)
  }

  return inspect.stdout.toString().trim()
}
