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
  gradleTasks?: string
  gradleArgs?: string
  cacheRef?: string
  useBuildx?: boolean
}

export const buildImage = async (options: BuildImageOptions = {}) => {
  const registry = options.registry ?? process.env.GRAF_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? process.env.GRAF_IMAGE_REPOSITORY ?? 'proompteng/graf'
  const tag = options.tag ?? process.env.GRAF_IMAGE_TAG ?? 'latest'
  const context = resolve(repoRoot, options.context ?? process.env.GRAF_BUILD_CONTEXT ?? 'services/graf')
  const dockerfile = resolve(repoRoot, options.dockerfile ?? process.env.GRAF_DOCKERFILE ?? 'services/graf/Dockerfile')
  const version = options.version ?? process.env.GRAF_VERSION ?? execGit(['describe', '--tags', '--always'])
  const commit = options.commit ?? process.env.GRAF_COMMIT ?? execGit(['rev-parse', 'HEAD'])
  const gradleTasks = options.gradleTasks ?? process.env.GRAF_GRADLE_TASKS
  const gradleArgs = options.gradleArgs ?? process.env.GRAF_GRADLE_ARGS
  const cacheRef = options.cacheRef ?? process.env.GRAF_BUILD_CACHE_REF ?? `${registry}/${repository}:buildcache`
  const useBuildx =
    options.useBuildx ??
    (process.env.GRAF_USE_BUILDX ? ['1', 'true', 'yes', 'y', 'on'].includes(process.env.GRAF_USE_BUILDX) : undefined)

  const result = await buildAndPushDockerImage({
    registry,
    repository,
    tag,
    context,
    dockerfile,
    cacheRef,
    useBuildx,
    buildArgs: {
      GRAF_VERSION: version,
      GRAF_COMMIT: commit,
      ...(gradleTasks ? { GRAF_GRADLE_TASKS: gradleTasks } : {}),
      ...(gradleArgs ? { GRAF_GRADLE_ARGS: gradleArgs } : {}),
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
