#!/usr/bin/env bun

import { resolve } from 'node:path'
import process from 'node:process'

import { ensureCli, repoRoot, run } from '../shared/cli'

type Options = {
  namespace: string
  appName: string
  manifestPath: string
  apply: boolean
  showStatus: boolean
}

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false
  return fallback
}

const parseArgs = (argv: string[]): Partial<Options> => {
  const options: Partial<Options> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--namespace') {
      options.namespace = argv[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--namespace=')) {
      options.namespace = arg.slice('--namespace='.length)
      continue
    }
    if (arg === '--app') {
      options.appName = argv[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--app=')) {
      options.appName = arg.slice('--app='.length)
      continue
    }
    if (arg === '--manifest') {
      options.manifestPath = argv[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--manifest=')) {
      options.manifestPath = arg.slice('--manifest='.length)
      continue
    }
    if (arg === '--no-apply') {
      options.apply = false
      continue
    }
    if (arg === '--no-status') {
      options.showStatus = false
    }
  }
  return options
}

const resolveOptions = (): Options => {
  const args = parseArgs(process.argv.slice(2))
  const namespace = args.namespace ?? process.env.ARGOCD_NAMESPACE ?? 'argocd'
  const appName = args.appName ?? process.env.ARGOCD_APP_NAME ?? 'agents'
  const manifestPath =
    args.manifestPath ?? process.env.ARGOCD_APP_MANIFEST ?? 'argocd/applications/agents/application.yaml'

  return {
    namespace,
    appName,
    manifestPath: resolve(repoRoot, manifestPath),
    apply: args.apply ?? parseBoolean(process.env.ARGOCD_APPLY, true),
    showStatus: args.showStatus ?? parseBoolean(process.env.ARGOCD_SHOW_STATUS, true),
  }
}

const main = async () => {
  const options = resolveOptions()
  ensureCli('kubectl')

  if (options.apply) {
    await run('kubectl', ['-n', options.namespace, 'apply', '-f', options.manifestPath])
  }

  if (options.showStatus) {
    await run('kubectl', ['-n', options.namespace, 'get', 'application', options.appName])
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

export const __private = {
  parseArgs,
  parseBoolean,
  resolveOptions,
}
