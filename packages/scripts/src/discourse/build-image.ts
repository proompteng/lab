#!/usr/bin/env bun

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

import { ensureCli, repoRoot, run } from '../shared/cli'
import { execGit } from '../shared/git'

export type BuildImageOptions = {
  registry?: string
  repository?: string
  tag?: string
  discourseRoot?: string
  config?: string
  dockerArgs?: string
  skipPrereqs?: boolean
  runImage?: string
}

type BuildImageResult = {
  image: string
  localImage: string
  registry: string
  repository: string
  tag: string
  config: string
  discourseRoot: string
}

const isTruthy = (value: string | undefined): boolean => {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return (
    normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'y' || normalized === 'on'
  )
}

const resolveDefaults = (options: BuildImageOptions) => {
  const registry = options.registry ?? process.env.DISCOURSE_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? process.env.DISCOURSE_IMAGE_REPOSITORY ?? 'lab/discourse'
  const tag = options.tag ?? process.env.DISCOURSE_IMAGE_TAG ?? execGit(['rev-parse', '--short', 'HEAD'])
  const discourseRoot = resolve(
    repoRoot,
    options.discourseRoot ?? process.env.DISCOURSE_DOCKER_ROOT ?? 'apps/discourse',
  )
  const config = options.config ?? process.env.DISCOURSE_CONFIG ?? 'app'
  const dockerArgs = options.dockerArgs ?? process.env.DISCOURSE_DOCKER_ARGS
  const skipPrereqs = options.skipPrereqs ?? isTruthy(process.env.DISCOURSE_SKIP_PREREQS)
  const runImage = options.runImage ?? process.env.DISCOURSE_RUN_IMAGE

  return {
    registry,
    repository,
    tag,
    discourseRoot,
    config,
    dockerArgs,
    skipPrereqs,
    runImage,
  }
}

const ensurePathExists = (path: string, label: string) => {
  if (!existsSync(path)) {
    throw new Error(`${label} not found at ${path}`)
  }
}

const normalizeRuntimeImage = async (localImage: string, cwd: string) => {
  const containerName = `discourse-runtime-${Date.now()}`
  const cleanup = async () => {
    await run('docker', ['rm', '-f', containerName], { cwd }).catch(() => undefined)
  }

  const fixups = [
    'rm -rf /etc/service/postgres /etc/service/redis',
    "sed -i 's/^\\s*sv start postgres.*$/true/' /etc/service/unicorn/run",
    "sed -i 's/^\\s*sv start redis.*$/true/' /etc/service/unicorn/run",
    'rm -f /etc/runit/3.d/99-postgres /etc/runit/3.d/10-redis',
  ].join(' && ')

  try {
    await run('docker', ['run', '--name', containerName, '--entrypoint', '/bin/bash', localImage, '-lc', fixups], {
      cwd,
    })
    await run(
      'docker',
      ['commit', '--change', 'ENTRYPOINT []', '--change', 'CMD ["/sbin/boot"]', containerName, localImage],
      { cwd },
    )
  } finally {
    await cleanup()
  }
}

const buildWithLauncher = async (options: ReturnType<typeof resolveDefaults>) => {
  const launcherPath = resolve(options.discourseRoot, 'launcher')
  const configPath = resolve(options.discourseRoot, 'containers', `${options.config}.yml`)

  ensurePathExists(options.discourseRoot, 'Discourse Docker root')
  ensurePathExists(launcherPath, 'Discourse launcher script')
  if (!existsSync(configPath)) {
    const examplePath = `${configPath}.example`
    if (existsSync(examplePath)) {
      throw new Error(
        `Discourse container config not found at ${configPath}. Copy ${examplePath} and fill in the values.`,
      )
    }
    throw new Error(`Discourse container config not found at ${configPath}`)
  }

  const args = ['bootstrap', options.config]
  if (options.skipPrereqs) {
    args.push('--skip-prereqs')
  }
  if (options.dockerArgs && options.dockerArgs.length > 0) {
    args.push('--docker-args', options.dockerArgs)
  }
  if (options.runImage && options.runImage.length > 0) {
    args.push('--run-image', options.runImage)
  }

  await run(launcherPath, args, { cwd: options.discourseRoot })
  await normalizeRuntimeImage(`local_discourse/${options.config}`, options.discourseRoot)
}

export const buildImage = async (options: BuildImageOptions = {}): Promise<BuildImageResult> => {
  ensureCli('docker')
  ensureCli('git')
  ensureCli('bash')

  const resolved = resolveDefaults(options)
  await buildWithLauncher(resolved)

  const localImage = `local_discourse/${resolved.config}`
  const image = `${resolved.registry}/${resolved.repository}:${resolved.tag}`

  await run('docker', ['tag', localImage, image], { cwd: resolved.discourseRoot })
  await run('docker', ['push', image], { cwd: resolved.discourseRoot })

  return {
    image,
    localImage,
    registry: resolved.registry,
    repository: resolved.repository,
    tag: resolved.tag,
    config: resolved.config,
    discourseRoot: resolved.discourseRoot,
  }
}

if (import.meta.main) {
  buildImage().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
