#!/usr/bin/env bun

import { copyFileSync, cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { ensureCli, repoRoot, run } from '../shared/cli'
import { buildAndPushDockerImage, type DockerCacheMode } from '../shared/docker'
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
  cacheMode?: DockerCacheMode
}

type BuildConfiguration = {
  registry: string
  repository: string
  tag: string
  usePrune: boolean
  dockerfile: string
  target?: string
  version: string
  commit: string
  codexAuthPath: string
  cacheRef: string
  cacheMode?: DockerCacheMode
  platforms?: string[]
  buildArgs: Record<string, string>
}

const parsePlatforms = (value: string | undefined): string[] | undefined => {
  if (!value) return undefined
  const platforms = value
    .split(',')
    .map((platform) => platform.trim())
    .filter(Boolean)

  return platforms.length > 0 ? platforms : undefined
}

const defaultPruneScopesForTarget = (target: string | undefined): string[] => [
  '@proompteng/agents',
  '@proompteng/agent-contracts',
  '@proompteng/otel',
  '@proompteng/temporal-bun-sdk',
]

const parsePruneScopes = (value: string | undefined, target?: string): string[] => {
  const fallback = defaultPruneScopesForTarget(target)
  const scopes = (value ?? fallback.join(','))
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean)
  const normalizedScopes = scopes.length > 0 ? scopes : fallback
  if (normalizedScopes.includes('@proompteng/jangar')) {
    throw new Error('Agents images must not prune or package @proompteng/jangar')
  }
  return normalizedScopes
}

const removeNestedNodeModules = (root: string) => {
  if (!existsSync(root)) return

  const directories = [root]
  while (directories.length > 0) {
    const current = directories.pop()
    if (!current) continue

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue

      const entryPath = resolve(current, entry.name)
      if (entry.name === 'node_modules') {
        rmSync(entryPath, { recursive: true, force: true })
        continue
      }

      directories.push(entryPath)
    }
  }
}

const parseCacheMode = (value: string | undefined): DockerCacheMode | undefined => {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'min') return 'min'
  if (normalized === 'max') return 'max'
  return undefined
}

const readAgentsEnv = (agentsName: string) => process.env[agentsName]?.trim()

const createPrunedContext = async (target?: string): Promise<{ dir: string; cleanup: () => void }> => {
  ensureCli('bunx')

  const dir = mkdtempSync(resolve(tmpdir(), 'agents-prune-'))
  const cleanup = () => rmSync(dir, { recursive: true, force: true })

  try {
    const scopes = parsePruneScopes(process.env.AGENTS_BUILD_PRUNE_SCOPE, target)
    await run(
      'bunx',
      ['turbo', 'prune', ...scopes.flatMap((scope) => ['--scope', scope]), '--docker', `--out-dir=${dir}`],
      {
        cwd: repoRoot,
      },
    )

    // `turbo prune --docker` does not currently include this file, but workspace TS configs extend it.
    copyFileSync(resolve(repoRoot, 'tsconfig.base.json'), resolve(dir, 'tsconfig.base.json'))

    const skillsSource = resolve(repoRoot, 'skills')
    if (existsSync(skillsSource)) {
      cpSync(skillsSource, resolve(dir, 'skills'), { recursive: true })
    }

    const cxToolsSource = resolve(repoRoot, 'packages/cx-tools')
    if (existsSync(cxToolsSource)) {
      cpSync(cxToolsSource, resolve(dir, 'full/packages/cx-tools'), { recursive: true })
      cpSync(cxToolsSource, resolve(dir, 'json/packages/cx-tools'), { recursive: true })
    }

    removeNestedNodeModules(resolve(dir, 'full'))
    removeNestedNodeModules(resolve(dir, 'json'))

    return { dir, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}

const buildArgsFromEnv = (version: string, commit: string): Record<string, string> => {
  const buildArgs: Record<string, string> = {
    AGENTS_VERSION: version,
    AGENTS_COMMIT: commit,
  }

  const buildNodeOptions = readAgentsEnv('AGENTS_BUILD_NODE_OPTIONS')
  if (buildNodeOptions) buildArgs.AGENTS_BUILD_NODE_OPTIONS = buildNodeOptions

  const buildMinify = readAgentsEnv('AGENTS_BUILD_MINIFY')
  if (buildMinify) buildArgs.AGENTS_BUILD_MINIFY = buildMinify

  const buildSourceMap = readAgentsEnv('AGENTS_BUILD_SOURCEMAP')
  if (buildSourceMap) buildArgs.AGENTS_BUILD_SOURCEMAP = buildSourceMap

  const buildCi = readAgentsEnv('AGENTS_BUILD_CI')
  if (buildCi) buildArgs.AGENTS_BUILD_CI = buildCi

  const buildLogLevel = readAgentsEnv('AGENTS_BUILD_LOG_LEVEL')
  if (buildLogLevel) buildArgs.AGENTS_BUILD_LOG_LEVEL = buildLogLevel

  if (process.env.BUILDX_VERSION) {
    buildArgs.BUILDX_VERSION = process.env.BUILDX_VERSION
  }

  return buildArgs
}

const resolveBuildConfiguration = (options: BuildImageOptions = {}): BuildConfiguration => {
  const registry = options.registry ?? process.env.AGENTS_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? process.env.AGENTS_IMAGE_REPOSITORY ?? 'lab/agents-control-plane'
  const tag = options.tag ?? process.env.AGENTS_IMAGE_TAG ?? execGit(['rev-parse', '--short', 'HEAD'])
  const usePrune = options.context === undefined && process.env.AGENTS_BUILD_CONTEXT === undefined
  const dockerfile = resolve(
    repoRoot,
    options.dockerfile ?? process.env.AGENTS_DOCKERFILE ?? 'services/agents/Dockerfile',
  )
  const target = options.target ?? process.env.AGENTS_DOCKER_TARGET ?? undefined
  const version = options.version ?? process.env.AGENTS_VERSION ?? tag
  const commit = options.commit ?? process.env.AGENTS_COMMIT ?? execGit(['rev-parse', 'HEAD'])
  const codexAuthPath =
    options.codexAuthPath ?? process.env.CODEX_AUTH_PATH ?? resolve(process.env.HOME ?? '', '.codex/auth.json')
  const cacheRef = options.cacheRef ?? process.env.AGENTS_BUILD_CACHE_REF ?? `${registry}/${repository}:buildcache`
  const cacheMode = options.cacheMode ?? parseCacheMode(process.env.AGENTS_BUILD_CACHE_MODE)
  const platforms =
    options.platforms ??
    parsePlatforms(process.env.AGENTS_IMAGE_PLATFORMS) ??
    parsePlatforms(process.env.DOCKER_IMAGE_PLATFORMS)

  return {
    registry,
    repository,
    tag,
    usePrune,
    dockerfile,
    target,
    version,
    commit,
    codexAuthPath,
    cacheRef,
    cacheMode,
    platforms,
    buildArgs: buildArgsFromEnv(version, commit),
  }
}

export const buildImage = async (options: BuildImageOptions = {}) => {
  const config = resolveBuildConfiguration(options)

  let context: string
  let pruneCleanup: (() => void) | undefined

  try {
    if (config.usePrune) {
      const pruned = await createPrunedContext(config.target)
      context = pruned.dir
      pruneCleanup = pruned.cleanup
    } else {
      context = resolve(repoRoot, options.context ?? process.env.AGENTS_BUILD_CONTEXT ?? '.')
    }

    const codexAuthPathForDocker = existsSync(config.codexAuthPath) ? config.codexAuthPath : undefined
    if (!codexAuthPathForDocker) {
      console.warn(`Codex auth not found at ${config.codexAuthPath}; build will proceed without it.`)
    }

    const result = await buildAndPushDockerImage({
      registry: config.registry,
      repository: config.repository,
      tag: config.tag,
      context,
      dockerfile: config.dockerfile,
      target: config.target,
      buildArgs: config.buildArgs,
      codexAuthPath: codexAuthPathForDocker,
      cacheRef: config.cacheRef,
      cacheMode: config.cacheMode,
      platforms: config.platforms,
    })

    return { ...result, version: config.version, commit: config.commit }
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

export const __private = {
  buildArgsFromEnv,
  execGit,
  parsePlatforms,
  parsePruneScopes,
  resolveBuildConfiguration,
  removeNestedNodeModules,
}
