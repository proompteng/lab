#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

import { fatal, repoRoot } from '../shared/cli'
import { inspectOciImageDigest } from '../shared/oci-digest'

const defaultRegistry = 'registry.ide-newton.ts.net'
const defaultRepository = 'lab/torghut-notebook'
const defaultValuesPath = 'argocd/applications/torghut/notebooks/values.yaml'
const digestPattern = /^sha256:[0-9a-f]{64}$/i

type CliOptions = {
  registry?: string
  repository?: string
  tag?: string
  digest?: string
  valuesPath?: string
}

const normalizeDigest = (value: string): string => {
  const trimmed = value.trim()
  return trimmed.includes('@') ? trimmed.slice(trimmed.lastIndexOf('@') + 1) : trimmed
}

const updateNotebookManifest = (imageName: string, digest: string, valuesPathValue: string) => {
  const valuesPath = resolve(repoRoot, valuesPathValue)
  const source = readFileSync(valuesPath, 'utf8')
  const lines = source.split('\n')
  let inSingleuser = false
  let inImage = false
  let sawName = false
  let tagIndex = -1

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (/^[^\s]/.test(line)) {
      inSingleuser = line === 'singleuser:'
      inImage = false
      continue
    }
    if (!inSingleuser) continue
    if (/^  [^\s]/.test(line)) {
      inImage = line === '  image:'
      continue
    }
    if (!inImage) continue
    const nameMatch = line.match(/^    name:\s*(\S+)\s*$/)
    if (nameMatch) {
      const expected = `${imageName}@sha256`
      if (nameMatch[1] !== expected) {
        throw new Error(`Notebook image name must be ${expected}, got ${nameMatch[1]}`)
      }
      sawName = true
      continue
    }
    if (/^    tag:\s*['"]?[0-9a-f]{64}['"]?\s*$/i.test(line)) {
      tagIndex = index
      break
    }
  }

  if (!sawName || tagIndex < 0) {
    throw new Error('Unable to locate digest-pinned singleuser notebook image in values.yaml')
  }
  const digestHex = digest.slice('sha256:'.length).toLowerCase()
  lines[tagIndex] = `    tag: '${digestHex}'`
  const updated = lines.join('\n')
  if (updated !== source) {
    writeFileSync(valuesPath, updated, 'utf8')
  }
  return {
    valuesPath,
    imageRef: `${imageName}@${digest}`,
    changed: updated !== source,
  }
}

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bun run packages/scripts/src/torghut/update-notebook-manifest.ts [options]

Options:
  --registry <value>
  --repository <value>
  --tag <value>
  --digest <sha256:...>
  --values-path <path>`)
      process.exit(0)
    }
    if (!arg?.startsWith('--')) throw new Error(`Unknown argument: ${arg}`)
    const [flag, inlineValue] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined]
    const value = inlineValue ?? argv[index + 1]
    if (inlineValue === undefined) index += 1
    if (value === undefined) throw new Error(`Missing value for ${flag}`)
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
      case '--values-path':
        options.valuesPath = value
        break
      default:
        throw new Error(`Unknown option: ${flag}`)
    }
  }
  return options
}

const main = (cliOptions?: CliOptions) => {
  const options = cliOptions ?? parseArgs(process.argv.slice(2))
  const registry = options.registry ?? process.env.TORGHUT_NOTEBOOK_IMAGE_REGISTRY ?? defaultRegistry
  const repository = options.repository ?? process.env.TORGHUT_NOTEBOOK_IMAGE_REPOSITORY ?? defaultRepository
  const tag = options.tag ?? process.env.TORGHUT_NOTEBOOK_IMAGE_TAG ?? 'latest'
  const imageName = `${registry}/${repository}`
  const digest = normalizeDigest(
    options.digest ?? process.env.TORGHUT_NOTEBOOK_IMAGE_DIGEST ?? inspectOciImageDigest(`${imageName}:${tag}`),
  )
  if (!digestPattern.test(digest)) {
    throw new Error(`Resolved digest '${digest}' is invalid; expected sha256:<64 hex>`)
  }
  const valuesPath = options.valuesPath ?? process.env.TORGHUT_NOTEBOOK_VALUES_PATH ?? defaultValuesPath
  const result = updateNotebookManifest(imageName, digest, valuesPath)
  console.log(
    result.changed
      ? `Updated ${result.valuesPath} with ${result.imageRef}`
      : `No notebook manifest changes required for ${result.imageRef}`,
  )
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    fatal(error instanceof Error ? error.message : String(error))
  }
}

export const __private = { normalizeDigest, parseArgs, updateNotebookManifest }
