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
  cacheRef?: string
}

export const buildImage = async (options: BuildImageOptions = {}) => {
  const registry = options.registry ?? process.env.SYMPHONY_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? process.env.SYMPHONY_IMAGE_REPOSITORY ?? 'lab/symphony'
  const tag = options.tag ?? process.env.SYMPHONY_IMAGE_TAG ?? execGit(['rev-parse', '--short', 'HEAD'])
  const context = resolve(repoRoot, options.context ?? process.env.SYMPHONY_BUILD_CONTEXT ?? '.')
  const dockerfile = resolve(
    repoRoot,
    options.dockerfile ?? process.env.SYMPHONY_DOCKERFILE ?? 'services/symphony/Dockerfile',
  )
  const cacheRef = options.cacheRef ?? process.env.SYMPHONY_BUILD_CACHE_REF ?? `${registry}/${repository}:buildcache`

  return buildAndPushDockerImage({
    registry,
    repository,
    tag,
    context,
    dockerfile,
    cacheRef,
  })
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
