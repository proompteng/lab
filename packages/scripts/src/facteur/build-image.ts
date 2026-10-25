#!/usr/bin/env bun

import { resolve } from 'node:path'
import { repoRoot } from '../shared/cli'
import { buildAndPushDockerImage } from '../shared/docker'
import { execGit } from '../shared/git'

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
  const registry = options.registry ?? process.env.FACTEUR_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? process.env.FACTEUR_IMAGE_REPOSITORY ?? 'lab/facteur'
  const tag = options.tag ?? process.env.FACTEUR_IMAGE_TAG ?? 'latest'
  const context = resolve(repoRoot, options.context ?? process.env.FACTEUR_BUILD_CONTEXT ?? '.')
  const dockerfile = resolve(
    repoRoot,
    options.dockerfile ?? process.env.FACTEUR_DOCKERFILE ?? 'services/facteur/Dockerfile',
  )
  const version = options.version ?? process.env.FACTEUR_VERSION ?? execGit(['describe', '--tags', '--always'])
  const commit = options.commit ?? process.env.FACTEUR_COMMIT ?? execGit(['rev-parse', 'HEAD'])

  const result = await buildAndPushDockerImage({
    registry,
    repository,
    tag,
    context,
    dockerfile,
    buildArgs: {
      FACTEUR_VERSION: version,
      FACTEUR_COMMIT: commit,
    },
  })

  return { ...result, version, commit }
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
