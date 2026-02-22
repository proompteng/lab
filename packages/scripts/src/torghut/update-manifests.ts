#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

import { fatal, repoRoot } from '../shared/cli'
import { inspectImageDigest } from '../shared/docker'
import { execGit } from '../shared/git'

const defaultRegistry = 'registry.ide-newton.ts.net'
const defaultRepository = 'lab/torghut'
const defaultManifestPath = 'argocd/applications/torghut/knative-service.yaml'
const defaultMigrationManifestPath = 'argocd/applications/torghut/db-migrations-job.yaml'

const digestPattern = /^sha256:[0-9a-f]{64}$/i

type UpdateManifestsOptions = {
  imageName: string
  digest: string
  version: string
  commit: string
  rolloutTimestamp: string
  manifestPath?: string
  migrationManifestPath?: string
}

type CliOptions = {
  registry?: string
  repository?: string
  tag?: string
  digest?: string
  version?: string
  commit?: string
  rolloutTimestamp?: string
  manifestPath?: string
  migrationManifestPath?: string
}

const resolvePath = (path: string) => resolve(repoRoot, path)

const normalizeDigest = (value: string): string => {
  const trimmed = value.trim()
  if (!trimmed) {
    return trimmed
  }
  return trimmed.includes('@') ? trimmed.slice(trimmed.lastIndexOf('@') + 1) : trimmed
}

const replaceSingle = (source: string, pattern: RegExp, replacement: string, label: string): string => {
  if (!pattern.test(source)) {
    throw new Error(`Unable to locate ${label} in torghut manifest`)
  }
  return source.replace(pattern, replacement)
}

const updateTorghutManifest = (options: UpdateManifestsOptions) => {
  const manifestPath = resolvePath(options.manifestPath ?? defaultManifestPath)
  const source = readFileSync(manifestPath, 'utf8')
  const imageRef = `${options.imageName}@${options.digest}`

  let updated = source
  updated = replaceSingle(
    updated,
    /(client\.knative\.dev\/updateTimestamp:\s*)(?:"[^"]*"|'[^']*'|[^\n]+)/,
    `$1"${options.rolloutTimestamp}"`,
    'rollout timestamp annotation',
  )
  updated = replaceSingle(
    updated,
    /(- name:\s*user-container[\s\S]*?\n\s*image:\s*)([^\n]+)/,
    `$1${imageRef}`,
    'user-container image reference',
  )
  updated = replaceSingle(
    updated,
    /(- name:\s*TORGHUT_VERSION\s*\n\s*value:\s*)([^\n]+)/,
    `$1${options.version}`,
    'TORGHUT_VERSION',
  )
  updated = replaceSingle(
    updated,
    /(- name:\s*TORGHUT_COMMIT\s*\n\s*value:\s*)([^\n]+)/,
    `$1${options.commit}`,
    'TORGHUT_COMMIT',
  )
  updated = updated.replace(/^\s*serving\.knative\.dev\/creator:\s*[^\n]+\n/gm, '')
  updated = updated.replace(/^\s*serving\.knative\.dev\/lastModifier:\s*[^\n]+\n/gm, '')

  if (updated !== source) {
    writeFileSync(manifestPath, updated, 'utf8')
  }

  return {
    manifestPath,
    imageRef,
    changed: updated !== source,
  }
}

const updateTorghutMigrationManifest = (options: UpdateManifestsOptions) => {
  const manifestPath = resolvePath(options.migrationManifestPath ?? defaultMigrationManifestPath)
  const source = readFileSync(manifestPath, 'utf8')
  const imageRef = `${options.imageName}@${options.digest}`

  const updated = replaceSingle(
    source,
    /(- name:\s*migrate[\s\S]*?\n\s*image:\s*)([^\n]+)/,
    `$1${imageRef}`,
    'torghut-db-migrations image reference',
  )

  if (updated !== source) {
    writeFileSync(manifestPath, updated, 'utf8')
  }

  return {
    manifestPath,
    imageRef,
    changed: updated !== source,
  }
}

const updateTorghutManifests = (options: UpdateManifestsOptions) => {
  const service = updateTorghutManifest(options)
  const migration = updateTorghutMigrationManifest(options)
  const changedPaths = [service, migration].filter((entry) => entry.changed).map((entry) => entry.manifestPath)
  return {
    imageRef: service.imageRef,
    changed: changedPaths.length > 0,
    changedPaths,
  }
}

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = {}

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bun run packages/scripts/src/torghut/update-manifests.ts [options]

Options:
  --registry <value>
  --repository <value>
  --tag <value>
  --digest <sha256:...>
  --version <value>
  --commit <sha40>
  --rollout-timestamp <ISO8601>
  --manifest-path <path>
  --migration-manifest-path <path>`)
      process.exit(0)
    }

    if (!arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`)
    }

    const [flag, inlineValue] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined]
    const value = inlineValue ?? argv[i + 1]
    if (inlineValue === undefined) {
      i += 1
    }
    if (value === undefined) {
      throw new Error(`Missing value for ${flag}`)
    }

    switch (flag) {
      case '--registry':
        options.registry = value
        break
      case '--repository':
        options.repository = value
        break
      case '--tag':
        options.tag = value
        break
      case '--digest':
        options.digest = value
        break
      case '--version':
        options.version = value
        break
      case '--commit':
        options.commit = value
        break
      case '--rollout-timestamp':
        options.rolloutTimestamp = value
        break
      case '--manifest-path':
        options.manifestPath = value
        break
      case '--migration-manifest-path':
        options.migrationManifestPath = value
        break
      default:
        throw new Error(`Unknown option: ${flag}`)
    }
  }

  return options
}

export const main = (cliOptions?: CliOptions) => {
  const parsed = cliOptions ?? parseArgs(process.argv.slice(2))
  const registry = parsed.registry ?? process.env.TORGHUT_IMAGE_REGISTRY ?? defaultRegistry
  const repository = parsed.repository ?? process.env.TORGHUT_IMAGE_REPOSITORY ?? defaultRepository
  const tag = parsed.tag ?? process.env.TORGHUT_IMAGE_TAG ?? execGit(['rev-parse', '--short=8', 'HEAD'])
  const imageName = `${registry}/${repository}`
  const digest = normalizeDigest(
    parsed.digest ?? process.env.TORGHUT_IMAGE_DIGEST ?? inspectImageDigest(`${imageName}:${tag}`),
  )

  if (!digestPattern.test(digest)) {
    throw new Error(`Resolved digest '${digest}' is invalid; expected sha256:<64 hex>`)
  }

  const version = parsed.version ?? process.env.TORGHUT_VERSION ?? execGit(['describe', '--tags', '--always'])
  const commit = parsed.commit ?? process.env.TORGHUT_COMMIT ?? execGit(['rev-parse', 'HEAD'])
  const rolloutTimestamp = parsed.rolloutTimestamp ?? process.env.TORGHUT_ROLLOUT_TIMESTAMP ?? new Date().toISOString()

  const result = updateTorghutManifests({
    imageName,
    digest,
    version,
    commit,
    rolloutTimestamp,
    manifestPath: parsed.manifestPath ?? process.env.TORGHUT_MANIFEST_PATH,
    migrationManifestPath: parsed.migrationManifestPath ?? process.env.TORGHUT_MIGRATION_MANIFEST_PATH,
  })

  if (result.changed) {
    console.log(`Updated ${result.changedPaths.join(', ')} with ${result.imageRef}`)
  } else {
    console.log(`No manifest changes required for ${result.imageRef}`)
  }
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    fatal('Failed to update torghut manifests', error)
  }
}

export const __private = {
  normalizeDigest,
  parseArgs,
  replaceSingle,
  updateTorghutManifest,
  updateTorghutMigrationManifest,
  updateTorghutManifests,
}
