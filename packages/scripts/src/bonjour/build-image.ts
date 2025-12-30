#!/usr/bin/env bun

import { resolve } from 'node:path'
import { repoRoot } from '../shared/cli'
import { buildAndPushDockerImage } from '../shared/docker'

export type BuildImageOptions = {
  registry?: string
  repository?: string
  tag?: string
  context?: string
  dockerfile?: string
  platforms?: string[]
}

const parseTagArg = (args: string[]): string | undefined => {
  const first = args[0]?.trim()
  if (!first) return undefined
  if (first.startsWith('-')) return undefined
  return first
}

export const buildImage = async (options: BuildImageOptions = {}) => {
  const registry = options.registry ?? process.env.BONJOUR_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? process.env.BONJOUR_IMAGE_REPOSITORY ?? 'lab/bonjour'
  const tag = options.tag ?? process.env.BONJOUR_IMAGE_TAG ?? 'latest'
  const context = resolve(repoRoot, options.context ?? process.env.BONJOUR_BUILD_CONTEXT ?? '.')
  const dockerfile = resolve(
    repoRoot,
    options.dockerfile ?? process.env.BONJOUR_DOCKERFILE ?? 'services/bonjour/Dockerfile',
  )
  const platforms = options.platforms ??
    process.env.BONJOUR_IMAGE_PLATFORMS?.split(',').map((platform) => platform.trim()) ?? ['linux/arm64']

  const result = await buildAndPushDockerImage({
    registry,
    repository,
    tag,
    context,
    dockerfile,
    platforms,
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
