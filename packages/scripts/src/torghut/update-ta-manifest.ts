#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

import { fatal, repoRoot } from '../shared/cli'
import { execGit } from '../shared/git'
import { inspectOciImageDigest } from '../shared/oci-digest'

const defaultRegistry = 'registry.ide-newton.ts.net'
const defaultRepository = 'lab/torghut-ta'
const defaultManifestPaths = [
  'argocd/applications/torghut/ta/flinkdeployment.yaml',
  'argocd/applications/torghut/ta-sim/flinkdeployment.yaml',
  'argocd/applications/torghut/market-data-archive/flinkdeployment.yaml',
  'argocd/applications/torghut-options/ta/flinkdeployment.yaml',
]
const digestPattern = /^sha256:[0-9a-f]{64}$/i

type CliOptions = {
  registry?: string
  repository?: string
  tag?: string
  digest?: string
  version?: string
  commit?: string
  manifestPaths?: string[]
  bumpRestartNonce?: boolean
}

type UpdateOptions = {
  bumpRestartNonce?: boolean
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
    throw new Error(`Unable to locate ${label} in torghut ta manifest`)
  }
  return source.replace(pattern, replacement)
}

const bumpRestartNonce = (source: string): string => {
  const pattern = /^(\s*restartNonce:\s*)(\d+)(\s*)$/m
  if (!pattern.test(source)) {
    throw new Error('Unable to locate restartNonce in torghut ta manifest')
  }
  return source.replace(
    pattern,
    (_match, prefix: string, nonce: string, suffix: string) => `${prefix}${Number.parseInt(nonce, 10) + 1}${suffix}`,
  )
}

const updateTaManifest = (
  imageName: string,
  digest: string,
  version: string,
  commit: string,
  manifestPathValue: string,
  options: UpdateOptions = {},
) => {
  const manifestPath = resolvePath(manifestPathValue)
  const source = readFileSync(manifestPath, 'utf8')
  const imageRef = `${imageName}@${digest}`

  let updated = replaceSingle(source, /^(\s*image:\s*)([^\n]+)/m, `$1${imageRef}`, 'torghut-options-ta image reference')
  updated = replaceSingle(
    updated,
    /(- name:\s*TORGHUT_TA_VERSION\s*\n\s*value:\s*)([^\n]+)/,
    `$1${version}`,
    'TORGHUT_TA_VERSION',
  )
  updated = replaceSingle(
    updated,
    /(- name:\s*TORGHUT_TA_COMMIT\s*\n\s*value:\s*)([^\n]+)/,
    `$1${commit}`,
    'TORGHUT_TA_COMMIT',
  )
  if (options.bumpRestartNonce) {
    updated = bumpRestartNonce(updated)
  }

  if (updated !== source) {
    writeFileSync(manifestPath, updated, 'utf8')
  }

  return {
    manifestPath,
    imageRef,
    changed: updated !== source,
  }
}

const updateTaManifests = (
  imageName: string,
  digest: string,
  version: string,
  commit: string,
  manifestPaths: string[],
  options: UpdateOptions = {},
) => manifestPaths.map((manifestPath) => updateTaManifest(imageName, digest, version, commit, manifestPath, options))

const parseManifestPathList = (value: string): string[] =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = {}

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bun run packages/scripts/src/torghut/update-ta-manifest.ts [options]

Options:
  --registry <value>
  --repository <value>
  --tag <value>
  --digest <sha256:...>
  --version <value>
  --commit <sha40>
  --manifest-path <path>  May be repeated. Defaults to live, sim, archive, and options TA manifests.
  --bump-restart-nonce`)
      process.exit(0)
    }

    if (arg === '--bump-restart-nonce') {
      options.bumpRestartNonce = true
      continue
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
      case '--manifest-path':
        options.manifestPaths ??= []
        options.manifestPaths.push(value)
        break
      default:
        throw new Error(`Unknown option: ${flag}`)
    }
  }

  return options
}

const envManifestPaths = (): string[] | undefined => {
  if (process.env.TORGHUT_TA_MANIFEST_PATHS) {
    return parseManifestPathList(process.env.TORGHUT_TA_MANIFEST_PATHS)
  }
  if (process.env.TORGHUT_TA_MANIFEST_PATH) {
    return [process.env.TORGHUT_TA_MANIFEST_PATH]
  }
  return undefined
}

const main = (cliOptions?: CliOptions) => {
  const parsed = cliOptions ?? parseArgs(process.argv.slice(2))
  const registry = parsed.registry ?? process.env.TORGHUT_TA_IMAGE_REGISTRY ?? defaultRegistry
  const repository = parsed.repository ?? process.env.TORGHUT_TA_IMAGE_REPOSITORY ?? defaultRepository
  const tag = parsed.tag ?? process.env.TORGHUT_TA_IMAGE_TAG ?? execGit(['rev-parse', '--short=8', 'HEAD'])
  const imageName = `${registry}/${repository}`
  const digest = normalizeDigest(
    parsed.digest ?? process.env.TORGHUT_TA_IMAGE_DIGEST ?? inspectOciImageDigest(`${imageName}:${tag}`),
  )

  if (!digestPattern.test(digest)) {
    throw new Error(`Resolved digest '${digest}' is invalid; expected sha256:<64 hex>`)
  }

  const version = parsed.version ?? process.env.TORGHUT_TA_VERSION ?? execGit(['describe', '--tags', '--always'])
  const commit = parsed.commit ?? process.env.TORGHUT_TA_COMMIT ?? execGit(['rev-parse', 'HEAD'])
  const manifestPaths = parsed.manifestPaths ?? envManifestPaths() ?? defaultManifestPaths
  const bumpRestartNonceValue = parsed.bumpRestartNonce ?? process.env.TORGHUT_TA_BUMP_RESTART_NONCE === 'true'

  const results = updateTaManifests(imageName, digest, version, commit, manifestPaths, {
    bumpRestartNonce: bumpRestartNonceValue,
  })
  for (const result of results) {
    if (result.changed) {
      console.log(`Updated ${result.manifestPath} with ${result.imageRef}`)
    } else {
      console.log(`No manifest changes required for ${result.imageRef} in ${result.manifestPath}`)
    }
  }
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    fatal('Failed to update torghut ta manifest', error)
  }
}

export const __private = {
  bumpRestartNonce,
  envManifestPaths,
  normalizeDigest,
  parseArgs,
  parseManifestPathList,
  replaceSingle,
  updateTaManifest,
  updateTaManifests,
}
