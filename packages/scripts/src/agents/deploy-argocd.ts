#!/usr/bin/env bun

import { resolve } from 'node:path'
import process from 'node:process'

import { ensureCli, fatal, repoRoot, run } from '../shared/cli'

type Options = {
  namespace: string
  appName: string
  manifestPath: string
  apply: boolean
  sync: boolean
  wait: boolean
  timeoutSeconds: number
  useCore: boolean
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
    if (arg === '--no-sync') {
      options.sync = false
      continue
    }
    if (arg === '--no-wait') {
      options.wait = false
      continue
    }
    if (arg === '--timeout') {
      const value = Number.parseInt(argv[i + 1] ?? '', 10)
      if (!Number.isNaN(value)) {
        options.timeoutSeconds = value
      }
      i += 1
      continue
    }
    if (arg.startsWith('--timeout=')) {
      const value = Number.parseInt(arg.slice('--timeout='.length), 10)
      if (!Number.isNaN(value)) {
        options.timeoutSeconds = value
      }
      continue
    }
    if (arg === '--no-core') {
      options.useCore = false
      continue
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
    sync: args.sync ?? parseBoolean(process.env.ARGOCD_SYNC, true),
    wait: args.wait ?? parseBoolean(process.env.ARGOCD_WAIT, true),
    timeoutSeconds: args.timeoutSeconds ?? Number.parseInt(process.env.ARGOCD_TIMEOUT ?? '300', 10),
    useCore: args.useCore ?? parseBoolean(process.env.ARGOCD_CORE, true),
  }
}

const ensureArgocd = (options: Options) => {
  if (!options.sync && !options.wait) return
  if (!Bun.which('argocd')) {
    fatal('argocd CLI is required for sync/wait (set ARGOCD_SYNC=false or ARGOCD_WAIT=false to skip).')
  }
}

const main = async () => {
  const options = resolveOptions()
  ensureCli('kubectl')

  if (options.apply) {
    await run('kubectl', ['-n', options.namespace, 'apply', '-f', options.manifestPath])
  }

  await run('kubectl', ['-n', options.namespace, 'get', 'application', options.appName])

  ensureArgocd(options)

  if (options.sync) {
    const args = ['app', 'sync', options.appName]
    if (options.useCore) args.push('--core')
    await run('argocd', args)
  }

  if (options.wait) {
    const args = ['app', 'wait', options.appName, '--health', '--timeout', String(options.timeoutSeconds)]
    if (options.useCore) args.push('--core')
    await run('argocd', args)
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
