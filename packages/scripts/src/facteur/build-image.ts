#!/usr/bin/env bun

import { resolve } from 'node:path'
import { $ } from 'bun'
import { ensureCli, repoRoot } from '../shared/cli'

const execGit = (args: string[]): string => {
  const result = Bun.spawnSync(['git', ...args], { cwd: repoRoot })
  if (result.exitCode !== 0) {
    const joined = args.join(' ')
    throw new Error(`git ${joined} failed`)
  }
  return result.stdout.toString().trim()
}

export type BuildImageOptions = {
  registry?: string
  repository?: string
  tag?: string
  context?: string
  dockerfile?: string
  version?: string
  commit?: string
}

export const buildImage = async (options: BuildImageOptions = {}) => {
  ensureCli('docker')
  ensureCli('git')

  const registry = options.registry ?? process.env.FACTEUR_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? process.env.FACTEUR_IMAGE_REPOSITORY ?? 'lab/facteur'
  const tag = options.tag ?? process.env.FACTEUR_IMAGE_TAG ?? 'latest'
  const image = `${registry}/${repository}:${tag}`
  const context = resolve(repoRoot, options.context ?? process.env.FACTEUR_BUILD_CONTEXT ?? '.')
  const dockerfile = resolve(
    repoRoot,
    options.dockerfile ?? process.env.FACTEUR_DOCKERFILE ?? 'services/facteur/Dockerfile',
  )
  const version = options.version ?? process.env.FACTEUR_VERSION ?? execGit(['describe', '--tags', '--always'])
  const commit = options.commit ?? process.env.FACTEUR_COMMIT ?? execGit(['rev-parse', 'HEAD'])

  console.log('Building Facteur image with configuration:', {
    image,
    context,
    dockerfile,
    version,
    commit,
  })

  await $`docker build -f ${dockerfile} -t ${image} --build-arg FACTEUR_VERSION=${version} --build-arg FACTEUR_COMMIT=${commit} ${context}`

  await $`docker push ${image}`

  console.log(`Image pushed: ${image}`)

  return { image, tag, registry, repository }
}

if (import.meta.main) {
  buildImage().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

export const __private = {
  execGit,
}
