#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { ensureCli, fatal, repoRoot, run } from '../shared/cli'
import { execGit } from '../shared/git'
import { buildImage } from './build-image'

type CliOptions = {
  dryRun: boolean
  apply: boolean
  registry: string
  repository: string
  tag: string
  valuesPath: string
  kustomizePath: string
  namespace: string
  deploymentName: string
}

type ManifestUpdateOptions = {
  imageDigest: string
  valuesPath?: string
}

const defaultValuesPath = 'argocd/applications/headlamp/values.yaml'
const defaultKustomizePath = 'argocd/applications/headlamp'

const readEnv = (name: string) => process.env[name]?.trim()

const parseArgs = (argv: string[]): Partial<CliOptions> => {
  const options: Partial<CliOptions> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg) continue

    if (arg === '--dry-run') {
      options.dryRun = true
      options.apply = false
      continue
    }
    if (arg === '--no-apply') {
      options.apply = false
      continue
    }
    if (arg === '--tag') {
      options.tag = argv[index + 1]
      index += 1
      continue
    }
    if (arg.startsWith('--tag=')) {
      options.tag = arg.slice('--tag='.length)
      continue
    }
    if (arg === '--registry') {
      options.registry = argv[index + 1]
      index += 1
      continue
    }
    if (arg.startsWith('--registry=')) {
      options.registry = arg.slice('--registry='.length)
      continue
    }
    if (arg === '--repository') {
      options.repository = argv[index + 1]
      index += 1
      continue
    }
    if (arg.startsWith('--repository=')) {
      options.repository = arg.slice('--repository='.length)
      continue
    }
    if (arg === '--values-path') {
      options.valuesPath = argv[index + 1]
      index += 1
      continue
    }
    if (arg.startsWith('--values-path=')) {
      options.valuesPath = arg.slice('--values-path='.length)
      continue
    }
    if (arg === '--kustomize-path') {
      options.kustomizePath = argv[index + 1]
      index += 1
      continue
    }
    if (arg.startsWith('--kustomize-path=')) {
      options.kustomizePath = arg.slice('--kustomize-path='.length)
      continue
    }
    if (arg === '--namespace') {
      options.namespace = argv[index + 1]
      index += 1
      continue
    }
    if (arg.startsWith('--namespace=')) {
      options.namespace = arg.slice('--namespace='.length)
      continue
    }
    if (arg === '--deployment') {
      options.deploymentName = argv[index + 1]
      index += 1
      continue
    }
    if (arg.startsWith('--deployment=')) {
      options.deploymentName = arg.slice('--deployment='.length)
      continue
    }
    if (!arg.startsWith('-') && options.tag === undefined) {
      options.tag = arg
    }
  }
  return options
}

const resolveOptions = (argv = process.argv.slice(2)): CliOptions => {
  const parsed = parseArgs(argv)
  const dryRun = parsed.dryRun ?? readEnv('HEADLAMP_DRY_RUN') === 'true'

  return {
    dryRun,
    apply: dryRun ? false : (parsed.apply ?? readEnv('HEADLAMP_NO_APPLY') !== 'true'),
    registry: parsed.registry ?? readEnv('HEADLAMP_IMAGE_REGISTRY') ?? 'registry.ide-newton.ts.net',
    repository: parsed.repository ?? readEnv('HEADLAMP_IMAGE_REPOSITORY') ?? 'lab/headlamp',
    tag: parsed.tag ?? readEnv('HEADLAMP_IMAGE_TAG') ?? execGit(['rev-parse', '--short', 'HEAD']),
    valuesPath: parsed.valuesPath ?? readEnv('HEADLAMP_VALUES_PATH') ?? defaultValuesPath,
    kustomizePath: parsed.kustomizePath ?? readEnv('HEADLAMP_KUSTOMIZE_PATH') ?? defaultKustomizePath,
    namespace: parsed.namespace ?? readEnv('HEADLAMP_K8S_NAMESPACE') ?? 'headlamp',
    deploymentName: parsed.deploymentName ?? readEnv('HEADLAMP_K8S_DEPLOYMENT') ?? 'headlamp',
  }
}

const assertHeadlampImageDigest = (imageDigest: string): string => {
  const normalized = imageDigest.trim()
  if (!/^registry\.ide-newton\.ts\.net\/lab\/headlamp@sha256:[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(
      `Expected Headlamp digest reference registry.ide-newton.ts.net/lab/headlamp@sha256:<64 hex>, got ${imageDigest}`,
    )
  }
  return normalized
}

const updateHeadlampValues = (options: ManifestUpdateOptions): void => {
  const imageReference = assertHeadlampImageDigest(options.imageDigest)
  const digest = imageReference.split('@sha256:')[1]
  const path = resolve(repoRoot, options.valuesPath ?? defaultValuesPath)
  const current = readFileSync(path, 'utf8')

  let repositoryUpdates = 0
  let tagUpdates = 0
  const withRepository = current.replace(/^(\s*repository:\s*)lab\/headlamp(?:@sha256)?\s*$/m, (_match, prefix) => {
    repositoryUpdates += 1
    return `${prefix}lab/headlamp@sha256`
  })
  const updated = withRepository.replace(/^(\s*tag:\s*)[A-Za-z0-9_.:-]+(\s*)$/m, (_match, prefix, suffix) => {
    tagUpdates += 1
    return `${prefix}${digest}${suffix}`
  })

  if (repositoryUpdates !== 1 || tagUpdates !== 1) {
    throw new Error(
      `Expected one Headlamp repository and tag entry in ${options.valuesPath ?? defaultValuesPath}, found repository=${repositoryUpdates} tag=${tagUpdates}`,
    )
  }
  if (updated !== current) {
    writeFileSync(path, updated)
    console.log(`Updated ${path} with ${imageReference}`)
  }
}

export const main = async (argv = process.argv.slice(2)) => {
  const options = resolveOptions(argv)

  if (options.apply) {
    ensureCli('kubectl')
  }

  const imageResult = await buildImage({
    registry: options.registry,
    repository: options.repository,
    tag: options.tag,
    dryRun: options.dryRun,
  })
  console.log(`Image digest: ${imageResult.digest}`)

  if (options.dryRun) {
    console.log('Dry run complete; manifests and cluster state were not changed.')
    return
  }

  updateHeadlampValues({ imageDigest: imageResult.digest, valuesPath: options.valuesPath })

  if (!options.apply) {
    console.log('Skipping kubectl apply because --no-apply was requested.')
    return
  }

  await run('kubectl', ['apply', '-k', resolve(repoRoot, options.kustomizePath)])
  await run('kubectl', ['rollout', 'status', `deployment/${options.deploymentName}`, '-n', options.namespace])
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to build and deploy headlamp', error))
}

export const __private = {
  assertHeadlampImageDigest,
  parseArgs,
  resolveOptions,
  updateHeadlampValues,
}
