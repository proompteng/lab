#!/usr/bin/env bun

import { existsSync, readFileSync as readManifestSync } from 'node:fs'
import { resolve } from 'node:path'
import YAML from 'yaml'
import { ensureCli, fatal, repoRoot, run } from '../shared/cli'

type DeployTorghutAgentRunsOptions = {
  manifestPath: string
  apply: boolean
  dryRun: boolean
}

type OptionOverrides = Partial<{
  manifestPath: string
  apply: string
  dryRun: string
}>

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) {
    return fallback
  }
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false
  return fallback
}

const parseArgs = (argv: string[]): OptionOverrides => {
  const options: OptionOverrides = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--manifest' || arg === '--manifest-path') {
      const value = argv[i + 1]
      if (!value) {
        fatal(`${arg} requires a path value`)
      }
      options.manifestPath = value
      i += 1
      continue
    }
    if (arg.startsWith('--manifest=')) {
      options.manifestPath = arg.slice('--manifest='.length)
      continue
    }
    if (arg.startsWith('--manifest-path=')) {
      options.manifestPath = arg.slice('--manifest-path='.length)
      continue
    }
    if (arg === '--no-apply') {
      options.apply = 'false'
      continue
    }
    if (arg === '--apply') {
      options.apply = 'true'
      continue
    }
    if (arg === '--dry-run') {
      options.dryRun = 'true'
      continue
    }
    if (arg.startsWith('--apply=')) {
      options.apply = arg.slice('--apply='.length)
      continue
    }
    if (arg.startsWith('--dry-run=')) {
      options.dryRun = arg.slice('--dry-run='.length)
      continue
    }
  }
  return options
}

const resolveOptions = (): DeployTorghutAgentRunsOptions => {
  const args = parseArgs(process.argv.slice(2))
  return {
    manifestPath: resolve(
      repoRoot,
      args.manifestPath ??
        process.env.TORGHUT_AGENTRUNS_MANIFEST ??
        'argocd/applications/agents/torghut-agentruns.yaml',
    ),
    apply: parseBoolean(args.apply, parseBoolean(process.env.TORGHUT_AGENTRUNS_APPLY, true)),
    dryRun: parseBoolean(args.dryRun, parseBoolean(process.env.TORGHUT_AGENTRUNS_DRY_RUN, false)),
  }
}

const validateManifest = (path: string) => {
  if (!existsSync(path)) {
    fatal(`AgentRun manifest not found at ${path}`)
  }

  const expectedNames = new Set(['torghut-health-report-v1', 'torghut-gated-actuation-runner-v1'])
  const raw = readManifestSync(path, 'utf8')
  const documents = YAML.parseAllDocuments(raw)

  if (documents.length === 0) {
    fatal(`Manifest ${path} does not contain any YAML documents`)
  }

  for (const entry of documents) {
    if (entry.errors.length > 0) {
      fatal(`Failed to parse ${path}: ${entry.errors[0]?.message}`)
    }

    const parsed = entry.toJS() as {
      kind?: string
      metadata?: {
        name?: string
        namespace?: string
      }
    }
    if (!parsed || parsed.kind !== 'ImplementationSpec') {
      continue
    }

    if (parsed.metadata?.namespace !== 'agents') {
      fatal(`ImplementationSpec ${parsed.metadata?.name ?? '<unknown>'} must target namespace=agents`)
    }
    if (parsed.metadata?.name && expectedNames.has(parsed.metadata.name)) {
      expectedNames.delete(parsed.metadata.name)
    }
  }

  if (expectedNames.size > 0) {
    fatal(
      `Manifest ${path} is missing required torghut implementation specs: ${Array.from(expectedNames).sort().join(', ')}`,
    )
  }
}

const main = async () => {
  const options = resolveOptions()
  ensureCli('kubectl')
  validateManifest(options.manifestPath)
  const args = ['apply', '--filename', options.manifestPath]
  if (options.dryRun) {
    args.push('--dry-run=server')
  }
  if (options.apply) {
    await run('kubectl', args)
  } else {
    console.log(`Skipping apply for ${options.manifestPath} (--no-apply)`)
  }
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to deploy torghut AgentRun manifests', error))
}
