#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

import YAML from 'yaml'

import { fatal, repoRoot } from '../shared/cli'

const sourceShaPattern = /^[0-9a-f]{40}$/i
const defaultManifestPath = 'argocd/applications/torghut/knative-service.yaml'
const defaultEnvName = 'TORGHUT_COMMIT'

type CliOptions = {
  command?: 'source-sha'
  manifest?: string
  envName?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = {}

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bun run packages/scripts/src/torghut/source-ci.ts source-sha [options]

Commands:
  source-sha
    --manifest <path>        Manifest containing TORGHUT_COMMIT (default: ${defaultManifestPath})
    --env-name <name>        Env var name to read (default: ${defaultEnvName})`)
      process.exit(0)
    }

    if (!options.command && arg === 'source-sha') {
      options.command = arg
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
      case '--manifest':
        options.manifest = value
        break
      case '--env-name':
        options.envName = value
        break
      default:
        throw new Error(`Unknown option: ${flag}`)
    }
  }

  return options
}

const findNamedEnvValue = (value: unknown, envName: string): string | undefined => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNamedEnvValue(item, envName)
      if (found !== undefined) {
        return found
      }
    }
    return undefined
  }

  if (!isRecord(value)) {
    return undefined
  }

  const env = value.env
  if (Array.isArray(env)) {
    for (const entry of env) {
      if (!isRecord(entry) || text(entry.name) !== envName) {
        continue
      }
      const envValue = text(entry.value)
      if (!envValue) {
        throw new Error(`${envName} is present but empty`)
      }
      return envValue
    }
  }

  for (const child of Object.values(value)) {
    const found = findNamedEnvValue(child, envName)
    if (found !== undefined) {
      return found
    }
  }

  return undefined
}

export const assertValidSourceSha = (sourceSha: string): string => {
  const normalized = sourceSha.trim()
  if (!sourceShaPattern.test(normalized)) {
    throw new Error(`Invalid Torghut source SHA '${sourceSha}'`)
  }
  return normalized
}

export const extractSourceShaFromManifest = (manifestSource: string, envName = defaultEnvName): string => {
  const documents = YAML.parseAllDocuments(manifestSource)
  const errors = documents.flatMap((document) => document.errors)
  if (errors.length > 0) {
    throw new Error(`Unable to parse manifest YAML: ${errors.map((error) => error.message).join('; ')}`)
  }

  for (const document of documents) {
    const sourceSha = findNamedEnvValue(document.toJSON(), envName)
    if (sourceSha !== undefined) {
      return assertValidSourceSha(sourceSha)
    }
  }

  throw new Error(`${envName} was not found in manifest`)
}

export const readSourceShaFromManifest = (manifestPath: string, envName = defaultEnvName): string => {
  const path = resolve(repoRoot, manifestPath)
  return extractSourceShaFromManifest(readFileSync(path, 'utf8'), envName)
}

const main = (cliOptions?: CliOptions) => {
  const parsed = cliOptions ?? parseArgs(process.argv.slice(2))
  const command = parsed.command ?? 'source-sha'

  if (command === 'source-sha') {
    console.log(readSourceShaFromManifest(parsed.manifest ?? defaultManifestPath, parsed.envName ?? defaultEnvName))
    return
  }

  throw new Error(`Unknown command: ${String(command)}`)
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    fatal('Failed to resolve Torghut source CI metadata', error)
  }
}
