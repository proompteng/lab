#!/usr/bin/env bun

import { resolve } from 'node:path'
import process from 'node:process'
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

const parseTagArg = (args: string[]): string | undefined => {
  const first = args[0]?.trim()
  if (!first) return undefined
  if (first.startsWith('-')) return undefined
  return first
}

export const buildImage = async (options: BuildImageOptions = {}) => {
  const registry = options.registry ?? process.env.APP_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? process.env.APP_IMAGE_REPOSITORY ?? 'lab/app'
  const tag = options.tag ?? process.env.APP_IMAGE_TAG ?? execGit(['rev-parse', '--short', 'HEAD'])
  const context = resolve(repoRoot, options.context ?? process.env.APP_BUILD_CONTEXT ?? '.')
  const dockerfile = resolve(repoRoot, options.dockerfile ?? process.env.APP_DOCKERFILE ?? 'apps/app/Dockerfile')
  const platforms = options.platforms ??
    process.env.APP_IMAGE_PLATFORMS?.split(',').map((platform) => platform.trim()) ?? ['linux/arm64']
  const cacheRef = options.cacheRef ?? process.env.APP_BUILD_CACHE_REF ?? `${registry}/${repository}:buildcache`

  const result = await buildAndPushDockerImage({
    registry,
    repository,
    tag,
    context,
    dockerfile,
    platforms,
    cacheRef,
  })

  return result
}

if (import.meta.main) {
  const cliTag = parseTagArg(process.argv.slice(2))
  buildImage({ tag: cliTag }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

export const __private = {
  parseTagArg,
}
