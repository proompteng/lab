#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

import { fatal, repoRoot } from '../shared/cli'
import { inspectImageDigest } from '../shared/docker'
import { execGit } from '../shared/git'

const defaultRegistry = 'registry.ide-newton.ts.net'
const defaultRepository = 'lab/torghut-ta'
const defaultManifestPath = 'argocd/applications/torghut-options/ta/flinkdeployment.yaml'
const digestPattern = /^sha256:[0-9a-f]{64}$/i

type CliOptions = {
  registry?: string
  repository?: string
  tag?: string
  digest?: string
  version?: string
  commit?: string
  manifestPath?: string
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

export const updateTaManifest = (
  imageName: string,
  digest: string,
  version: string,
  commit: string,
  manifestPathValue: string,
) => {
  const manifestPath = resolvePath(manifestPathValue)
  const source = readFileSync(manifestPath, 'utf8')
  const imageRef = `${imageName}@${digest}`

  let updated = replaceSingle(
    source,
    /^(\s*image:\s*)([^\n]+)/m,
    `$1${imageRef}`,
    'torghut-options-ta image reference',
  )
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

  if (updated !== source) {
    writeFileSync(manifestPath, updated, 'utf8')
  }

  return {
    manifestPath,
    imageRef,
    changed: updated !== source,
  }
}

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
  --manifest-path <path>`)
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
      case '--manifest-path':
        options.manifestPath = value
        break
      default:
        throw new Error(`Unknown option: ${flag}`)
    }
  }

  return options
}

export const main = (cliOptions?: CliOptions) => {
  const parsed = cliOptions ?? parseArgs(process.argv.slice(2))
  const registry = parsed.registry ?? process.env.TORGHUT_TA_IMAGE_REGISTRY ?? defaultRegistry
  const repository = parsed.repository ?? process.env.TORGHUT_TA_IMAGE_REPOSITORY ?? defaultRepository
  const tag = parsed.tag ?? process.env.TORGHUT_TA_IMAGE_TAG ?? execGit(['rev-parse', '--short=8', 'HEAD'])
  const imageName = `${registry}/${repository}`
  const digest = normalizeDigest(
    parsed.digest ?? process.env.TORGHUT_TA_IMAGE_DIGEST ?? inspectImageDigest(`${imageName}:${tag}`),
  )

  if (!digestPattern.test(digest)) {
    throw new Error(`Resolved digest '${digest}' is invalid; expected sha256:<64 hex>`)
  }

  const version = parsed.version ?? process.env.TORGHUT_TA_VERSION ?? execGit(['describe', '--tags', '--always'])
  const commit = parsed.commit ?? process.env.TORGHUT_TA_COMMIT ?? execGit(['rev-parse', 'HEAD'])
  const manifestPath = parsed.manifestPath ?? process.env.TORGHUT_TA_MANIFEST_PATH ?? defaultManifestPath

  const result = updateTaManifest(imageName, digest, version, commit, manifestPath)
  if (result.changed) {
    console.log(`Updated ${result.manifestPath} with ${result.imageRef}`)
  } else {
    console.log(`No manifest changes required for ${result.imageRef}`)
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
  normalizeDigest,
  parseArgs,
  replaceSingle,
  updateTaManifest,
}
