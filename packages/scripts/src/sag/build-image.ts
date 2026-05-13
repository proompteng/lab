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
  platforms?: string[]
  cacheRef?: string
}

export const buildImage = async (options: BuildImageOptions = {}) => {
  const registry = options.registry ?? process.env.SAG_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? process.env.SAG_IMAGE_REPOSITORY ?? 'lab/sag'
  const tag = options.tag ?? process.env.SAG_IMAGE_TAG ?? execGit(['rev-parse', '--short', 'HEAD'])
  const context = resolve(repoRoot, options.context ?? process.env.SAG_BUILD_CONTEXT ?? '.')
  const dockerfile = resolve(repoRoot, options.dockerfile ?? process.env.SAG_DOCKERFILE ?? 'services/sag/Dockerfile')
  const platforms = options.platforms ??
    process.env.SAG_IMAGE_PLATFORMS?.split(',').map((platform) => platform.trim()) ?? ['linux/amd64']
  const cacheRef = options.cacheRef ?? process.env.SAG_BUILD_CACHE_REF ?? `${registry}/${repository}:buildcache`

  return buildAndPushDockerImage({
    registry,
    repository,
    tag,
    context,
    dockerfile,
    platforms,
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
