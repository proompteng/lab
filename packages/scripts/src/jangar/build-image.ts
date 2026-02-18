#!/usr/bin/env bun

import { copyFileSync, cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
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
  target?: string
  version?: string
  commit?: string
  codexAuthPath?: string
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

  const dir = mkdtempSync(resolve(tmpdir(), 'jangar-prune-'))
  const cleanup = () => rmSync(dir, { recursive: true, force: true })

  try {
    await run('bunx', ['turbo', 'prune', '--scope=@proompteng/jangar', '--docker', `--out-dir=${dir}`], {
      cwd: repoRoot,
    })

    // `turbo prune --docker` doesn't currently include this file, but our TS configs extend it.
    copyFileSync(resolve(repoRoot, 'tsconfig.base.json'), resolve(dir, 'tsconfig.base.json'))
    const skillsSource = resolve(repoRoot, 'skills')
    if (existsSync(skillsSource)) {
      cpSync(skillsSource, resolve(dir, 'skills'), { recursive: true })
    }
    const agentctlSource = resolve(repoRoot, 'services/jangar/agentctl')
    if (existsSync(agentctlSource)) {
      cpSync(agentctlSource, resolve(dir, 'full/services/jangar/agentctl'), { recursive: true })
      cpSync(agentctlSource, resolve(dir, 'json/services/jangar/agentctl'), { recursive: true })
    }
    // By default we do NOT copy a locally-built `.output` into the Docker build context.
    // Copying `.output` can silently ship stale server bundles if the local build was done on a different commit.
    // If you really need the faster path, opt in explicitly.
    if (process.env.JANGAR_USE_PREBUILT_OUTPUT?.trim().toLowerCase() === 'true') {
      const outputSource = resolve(repoRoot, 'services/jangar/.output')
      const outputEntry = resolve(outputSource, 'server/index.mjs')
      const outputProto = resolve(outputSource, 'server/proto/proompteng/jangar/v1/agentctl.proto')
      if (existsSync(outputEntry) && existsSync(outputProto)) {
        cpSync(outputSource, resolve(dir, 'full/services/jangar/.output'), { recursive: true })
      } else if (existsSync(outputSource)) {
        console.warn('Skipping prebuilt .output: missing services/jangar/.output/server/index.mjs or agentctl.proto')
      }
    }
    return { dir, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}

export const buildImage = async (options: BuildImageOptions = {}) => {
  const registry = options.registry ?? process.env.JANGAR_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? process.env.JANGAR_IMAGE_REPOSITORY ?? 'lab/jangar'
  const tag = options.tag ?? process.env.JANGAR_IMAGE_TAG ?? execGit(['rev-parse', '--short', 'HEAD'])
  const usePrune = options.context === undefined && process.env.JANGAR_BUILD_CONTEXT === undefined

  const dockerfile = resolve(
    repoRoot,
    options.dockerfile ?? process.env.JANGAR_DOCKERFILE ?? 'services/jangar/Dockerfile',
  )
  const target = options.target ?? process.env.JANGAR_DOCKER_TARGET ?? undefined
  const version = options.version ?? process.env.JANGAR_VERSION ?? tag
  const commit = options.commit ?? process.env.JANGAR_COMMIT ?? execGit(['rev-parse', 'HEAD'])
  const codexAuthPath =
    options.codexAuthPath ?? process.env.CODEX_AUTH_PATH ?? resolve(process.env.HOME ?? '', '.codex/auth.json')
  const cacheRef = options.cacheRef ?? process.env.JANGAR_BUILD_CACHE_REF ?? `${registry}/${repository}:buildcache`
  const platforms =
    options.platforms ??
    parsePlatforms(process.env.JANGAR_IMAGE_PLATFORMS) ??
    parsePlatforms(process.env.DOCKER_IMAGE_PLATFORMS)

  let context: string
  let pruneCleanup: (() => void) | undefined

  try {
    if (usePrune) {
      const pruned = await createPrunedContext()
      context = pruned.dir
      pruneCleanup = pruned.cleanup
    } else {
      context = resolve(repoRoot, options.context ?? process.env.JANGAR_BUILD_CONTEXT ?? '.')
    }

    const codexAuthPathForDocker = existsSync(codexAuthPath) ? codexAuthPath : undefined
    if (!codexAuthPathForDocker) {
      console.warn(`Codex auth not found at ${codexAuthPath}; build will proceed without it.`)
    }

    const buildArgs: Record<string, string> = {
      JANGAR_VERSION: version,
      JANGAR_COMMIT: commit,
    }
    const buildNodeOptions = process.env.JANGAR_BUILD_NODE_OPTIONS?.trim()
    if (buildNodeOptions) {
      buildArgs.JANGAR_BUILD_NODE_OPTIONS = buildNodeOptions
    }
    const buildMinify = process.env.JANGAR_BUILD_MINIFY?.trim()
    if (buildMinify) {
      buildArgs.JANGAR_BUILD_MINIFY = buildMinify
    }
    if (process.env.BUILDX_VERSION) {
      buildArgs.BUILDX_VERSION = process.env.BUILDX_VERSION
    }

    const result = await buildAndPushDockerImage({
      registry,
      repository,
      tag,
      context,
      dockerfile,
      target,
      buildArgs,
      codexAuthPath: codexAuthPathForDocker,
      cacheRef,
      platforms,
    })

    return { ...result, version, commit }
  } finally {
    pruneCleanup?.()
  }
}

if (import.meta.main) {
  buildImage().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

export const __private = { execGit }
