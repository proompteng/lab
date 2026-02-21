#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import YAML from 'yaml'

import { fatal, repoRoot } from '../shared/cli'
import { inspectImageDigest } from '../shared/docker'
import { execGit } from '../shared/git'

const defaultRegistry = 'registry.ide-newton.ts.net'
const defaultRepository = 'lab/jangar'
const defaultKustomizationPath = 'argocd/applications/jangar/kustomization.yaml'
const defaultServiceManifestPath = 'argocd/applications/jangar/deployment.yaml'
const defaultWorkerManifestPath = 'argocd/applications/jangar/jangar-worker-deployment.yaml'

export type UpdateManifestsOptions = {
  imageName: string
  tag: string
  digest?: string
  controlPlaneImageName?: string
  controlPlaneDigest?: string
  rolloutTimestamp: string
  kustomizationPath?: string
  serviceManifestPath?: string
  workerManifestPath?: string
  agentsValuesPath?: string
}

type CliOptions = {
  registry?: string
  repository?: string
  tag?: string
  digest?: string
  controlPlaneImageName?: string
  controlPlaneDigest?: string
  rolloutTimestamp?: string
  kustomizationPath?: string
  serviceManifestPath?: string
  workerManifestPath?: string
  agentsValuesPath?: string
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const resolvePath = (path: string) => resolve(repoRoot, path)

const normalizeDigest = (digest: string): string => {
  const trimmed = digest.trim()
  if (!trimmed) return trimmed
  const atIndex = trimmed.lastIndexOf('@')
  return atIndex >= 0 ? trimmed.slice(atIndex + 1) : trimmed
}

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return null
}

const updateKustomizationManifest = (
  kustomizationPath: string,
  imageName: string,
  tag: string,
  digest: string,
): boolean => {
  const source = readFileSync(kustomizationPath, 'utf8')
  const imagePattern = new RegExp(`(name:\\s+${escapeRegExp(imageName)}\\s*\\n\\s*newTag:\\s*)(.+)`, 'm')
  const quotedTag = JSON.stringify(tag)
  let updated = source.replace(imagePattern, (_, prefix) => `${prefix}${quotedTag}`)

  const digestPattern = new RegExp(
    `(name:\\s+${escapeRegExp(imageName)}\\s*\\n\\s*newTag:\\s*[^\\n]+\\n\\s*digest:\\s*)(.+)`,
    'm',
  )
  if (digestPattern.test(updated)) {
    updated = updated.replace(digestPattern, (_, prefix) => `${prefix}${digest}`)
  } else {
    updated = updated.replace(
      new RegExp(`(name:\\s+${escapeRegExp(imageName)}\\s*\\n\\s*newTag:\\s*[^\\n]+)`),
      `$1\n    digest: ${digest}`,
    )
  }

  if (source === updated) {
    console.warn('Warning: jangar kustomization was not updated; pattern may have changed.')
    return false
  }

  writeFileSync(kustomizationPath, updated)
  console.log(`Updated ${kustomizationPath} with tag ${tag} and digest ${digest}`)
  return true
}

const updateRolloutAnnotation = (
  manifestPath: string,
  annotationKey: string,
  rolloutTimestamp: string,
  warningLabel: string,
): boolean => {
  const source = readFileSync(manifestPath, 'utf8')
  const pattern = new RegExp(`(${escapeRegExp(annotationKey)}:\\s*)(["']?)([^"'\n]*)(["']?)`)
  const updated = source.replace(pattern, `$1"${rolloutTimestamp}"`)

  if (source === updated) {
    console.warn(`Warning: jangar ${warningLabel} annotation was not updated; pattern may have changed.`)
    return false
  }

  writeFileSync(manifestPath, updated)
  console.log(`Updated ${manifestPath} annotation ${annotationKey} to ${rolloutTimestamp}`)
  return true
}

const updateAgentsValuesManifest = (
  valuesPath: string,
  imageName: string,
  tag: string,
  digest: string,
  controlPlaneImageName?: string,
  controlPlaneDigest?: string,
): boolean => {
  const source = readFileSync(valuesPath, 'utf8')
  const parsed = YAML.parse(source)
  const doc = asRecord(parsed) ?? {}

  const image = asRecord(doc.image) ?? {}
  image.repository = imageName
  image.tag = tag
  image.digest = digest
  doc.image = image

  const runner = asRecord(doc.runner) ?? {}
  const runnerImage = asRecord(runner.image) ?? {}
  runnerImage.repository = imageName
  runnerImage.tag = tag
  runnerImage.digest = digest
  runner.image = runnerImage
  doc.runner = runner

  if (controlPlaneDigest) {
    const controlPlane = asRecord(doc.controlPlane) ?? {}
    const controlPlaneImage = asRecord(controlPlane.image) ?? {}
    const fallbackControlPlaneRepository = imageName.endsWith('/jangar')
      ? `${imageName.slice(0, -'/jangar'.length)}/jangar-control-plane`
      : `${imageName}-control-plane`
    const existingControlPlaneRepository =
      typeof controlPlaneImage.repository === 'string' ? controlPlaneImage.repository.trim() : ''
    controlPlaneImage.repository =
      controlPlaneImageName ?? (existingControlPlaneRepository || fallbackControlPlaneRepository)
    controlPlaneImage.tag = tag
    controlPlaneImage.digest = normalizeDigest(controlPlaneDigest)
    controlPlane.image = controlPlaneImage
    doc.controlPlane = controlPlane
  }

  const updated = YAML.stringify(doc, { lineWidth: 120 })
  if (source === updated) {
    console.warn('Warning: agents values were not updated; values already match requested image.')
    return false
  }

  writeFileSync(valuesPath, updated)
  console.log(`Updated ${valuesPath} with ${imageName}:${tag}@${digest}`)
  return true
}

export const updateJangarManifests = (options: UpdateManifestsOptions) => {
  const kustomizationPath = resolvePath(options.kustomizationPath ?? defaultKustomizationPath)
  const serviceManifestPath = resolvePath(options.serviceManifestPath ?? defaultServiceManifestPath)
  const workerManifestPath = resolvePath(options.workerManifestPath ?? defaultWorkerManifestPath)
  const digest = normalizeDigest(options.digest ?? inspectImageDigest(`${options.imageName}:${options.tag}`))
  const controlPlaneDigest = options.controlPlaneDigest ? normalizeDigest(options.controlPlaneDigest) : undefined
  const agentsValuesPath = options.agentsValuesPath ? resolvePath(options.agentsValuesPath) : null

  const kustomizationChanged = updateKustomizationManifest(kustomizationPath, options.imageName, options.tag, digest)
  const serviceChanged = updateRolloutAnnotation(
    serviceManifestPath,
    'deploy.knative.dev/rollout',
    options.rolloutTimestamp,
    'service rollout',
  )
  const workerChanged = updateRolloutAnnotation(
    workerManifestPath,
    'kubectl.kubernetes.io/restartedAt',
    options.rolloutTimestamp,
    'worker rollout',
  )
  const agentsValuesChanged = agentsValuesPath
    ? updateAgentsValuesManifest(
        agentsValuesPath,
        options.imageName,
        options.tag,
        digest,
        options.controlPlaneImageName,
        controlPlaneDigest,
      )
    : false

  return {
    tag: options.tag,
    digest,
    controlPlaneDigest,
    rolloutTimestamp: options.rolloutTimestamp,
    changed: {
      kustomization: kustomizationChanged,
      service: serviceChanged,
      worker: workerChanged,
      agentsValues: agentsValuesChanged,
    },
  }
}

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bun run packages/scripts/src/jangar/update-manifests.ts [options]

Options:
  --registry <value>
  --repository <value>
  --tag <value>
  --digest <value>
  --control-plane-image-name <value>
  --control-plane-digest <value>
  --rollout-timestamp <ISO8601>
  --kustomization-path <path>
  --service-manifest-path <path>
  --worker-manifest-path <path>
  --agents-values-path <path>`)
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
      case '--control-plane-image-name':
        options.controlPlaneImageName = value
        break
      case '--control-plane-digest':
        options.controlPlaneDigest = value
        break
      case '--rollout-timestamp':
        options.rolloutTimestamp = value
        break
      case '--kustomization-path':
        options.kustomizationPath = value
        break
      case '--service-manifest-path':
        options.serviceManifestPath = value
        break
      case '--worker-manifest-path':
        options.workerManifestPath = value
        break
      case '--agents-values-path':
        options.agentsValuesPath = value
        break
      default:
        throw new Error(`Unknown option: ${flag}`)
    }
  }

  return options
}

export const main = (cliOptions?: CliOptions) => {
  const parsed = cliOptions ?? parseArgs(process.argv.slice(2))
  const registry = parsed.registry ?? process.env.JANGAR_IMAGE_REGISTRY ?? defaultRegistry
  const repository = parsed.repository ?? process.env.JANGAR_IMAGE_REPOSITORY ?? defaultRepository
  const defaultTag = execGit(['rev-parse', '--short', 'HEAD'])
  const tag = parsed.tag ?? process.env.JANGAR_IMAGE_TAG ?? defaultTag
  const digest = parsed.digest ?? process.env.JANGAR_IMAGE_DIGEST
  const rolloutTimestamp = parsed.rolloutTimestamp ?? process.env.JANGAR_ROLLOUT_TIMESTAMP ?? new Date().toISOString()

  const result = updateJangarManifests({
    imageName: `${registry}/${repository}`,
    tag,
    digest,
    controlPlaneImageName: parsed.controlPlaneImageName ?? process.env.JANGAR_CONTROL_PLANE_IMAGE_NAME,
    controlPlaneDigest: parsed.controlPlaneDigest ?? process.env.JANGAR_CONTROL_PLANE_IMAGE_DIGEST,
    rolloutTimestamp,
    kustomizationPath: parsed.kustomizationPath ?? process.env.JANGAR_KUSTOMIZATION_PATH,
    serviceManifestPath: parsed.serviceManifestPath ?? process.env.JANGAR_SERVICE_MANIFEST,
    workerManifestPath: parsed.workerManifestPath ?? process.env.JANGAR_WORKER_MANIFEST,
    agentsValuesPath: parsed.agentsValuesPath ?? process.env.JANGAR_AGENTS_VALUES_PATH,
  })

  console.log(
    `Jangar manifest update complete (tag=${result.tag}, digest=${result.digest}, rollout=${result.rolloutTimestamp})`,
  )
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    fatal('Failed to update jangar manifests', error)
  }
}

export const __private = {
  parseArgs,
  normalizeDigest,
  updateKustomizationManifest,
  updateRolloutAnnotation,
  updateAgentsValuesManifest,
}
