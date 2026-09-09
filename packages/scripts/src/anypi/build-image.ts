#!/usr/bin/env bun

import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { ensureCli, repoRoot, run } from '../shared/cli'
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
  cacheRef?: string
  platforms?: string[]
}

const parsePlatforms = (value: string | undefined): string[] | undefined => {
  if (!value) return undefined
  const platforms = value
    .split(',')
    .map((platform) => platform.trim())
    .filter(Boolean)
  return platforms.length > 0 ? platforms : undefined
}

const createPrunedContext = async (): Promise<{ dir: string; cleanup: () => void }> => {
  ensureCli('bunx')
  const dir = mkdtempSync(resolve(tmpdir(), 'anypi-prune-'))
  const cleanup = () => rmSync(dir, { recursive: true, force: true })
  try {
    await run('bunx', ['turbo', 'prune', '--scope=@proompteng/anypi', '--docker', `--out-dir=${dir}`], {
      cwd: repoRoot,
    })
    copyFileSync(resolve(repoRoot, 'tsconfig.base.json'), resolve(dir, 'tsconfig.base.json'))
    return { dir, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}

export const buildImage = async (options: BuildImageOptions = {}) => {
  const registry = options.registry ?? process.env.ANYPI_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? process.env.ANYPI_IMAGE_REPOSITORY ?? 'lab/anypi'
  const tag = options.tag ?? process.env.ANYPI_IMAGE_TAG ?? execGit(['rev-parse', '--short', 'HEAD'])
  const dockerfile = resolve(
    repoRoot,
    options.dockerfile ?? process.env.ANYPI_DOCKERFILE ?? 'services/anypi/Dockerfile',
  )
  const commit = options.commit ?? process.env.ANYPI_COMMIT ?? execGit(['rev-parse', 'HEAD'])
  const cacheRef = options.cacheRef ?? process.env.ANYPI_BUILD_CACHE_REF ?? `${registry}/${repository}:buildcache`
  const platforms = options.platforms ??
    parsePlatforms(process.env.ANYPI_IMAGE_PLATFORMS) ??
    parsePlatforms(process.env.DOCKER_IMAGE_PLATFORMS) ?? ['linux/amd64', 'linux/arm64']
  const usePrune = options.context === undefined && process.env.ANYPI_BUILD_CONTEXT === undefined
  let context: string
  let cleanup: (() => void) | undefined

  try {
    if (usePrune) {
      const pruned = await createPrunedContext()
      context = pruned.dir
      cleanup = pruned.cleanup
    } else {
      context = resolve(repoRoot, options.context ?? process.env.ANYPI_BUILD_CONTEXT ?? '.')
    }
    const result = await buildAndPushDockerImage({
      registry,
      repository,
      tag,
      context,
      dockerfile,
      buildArgs: {
        LAB_GIT_SHA: commit,
      },
      cacheRef,
      platforms,
    })
    return { ...result, commit, version: options.version ?? tag }
  } finally {
    cleanup?.()
  }
}

if (import.meta.main) {
  buildImage().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

export const __private = {
  execGit,
  parsePlatforms,
}
