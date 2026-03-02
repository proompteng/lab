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
const defaultRunnerImageBinary = '/usr/local/bin/agent-runner'
const defaultKustomizationPath = 'argocd/applications/jangar/kustomization.yaml'
const defaultServiceManifestPath = 'argocd/applications/jangar/deployment.yaml'
const defaultWorkerManifestPath = 'argocd/applications/jangar/jangar-worker-deployment.yaml'
const dockerImagePlatformMap: Record<string, string> = {
  x86_64: 'linux/amd64',
  x64: 'linux/amd64',
  amd64: 'linux/amd64',
  arm64: 'linux/arm64',
  aarch64: 'linux/arm64',
}

type SpawnSync = typeof Bun.spawnSync

let spawnSyncImpl: SpawnSync = Bun.spawnSync

export type UpdateManifestsOptions = {
  imageName: string
  tag: string
  digest?: string
  controlPlaneImageName?: string
  controlPlaneDigest?: string
  runnerImageName?: string
  runnerImageTag?: string
  runnerImageDigest?: string
  runnerImageBinary?: string
  runnerImagePlatform?: string
  verifyRunnerImage?: boolean
  verifyRunnerImageOnly?: boolean
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
  runnerImageName?: string
  runnerImageTag?: string
  runnerImageDigest?: string
  runnerImageBinary?: string
  runnerImagePlatform?: string
  verifyRunnerImage?: boolean
  verifyRunnerImageOnly?: boolean
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

const parseBoolean = (value: string): boolean => {
  const normalized = value.trim().toLowerCase()
  if (
    normalized === '1' ||
    normalized === 'true' ||
    normalized === 'on' ||
    normalized === 'yes' ||
    normalized === 'y'
  ) {
    return true
  }
  if (
    normalized === '0' ||
    normalized === 'false' ||
    normalized === 'off' ||
    normalized === 'no' ||
    normalized === 'n'
  ) {
    return false
  }
  throw new Error(`Invalid boolean value: ${value}`)
}

const setSpawnSync = (fn?: SpawnSync) => {
  spawnSyncImpl = fn ?? Bun.spawnSync
}

const booleanFlagValues = new Set(['1', 'true', 'on', 'yes', 'y', '0', 'false', 'off', 'no', 'n'])

const normalizePlatform = (platform?: string): string | undefined => {
  if (!platform) return undefined
  const trimmed = platform.trim().toLowerCase()
  if (!trimmed) return undefined
  if (trimmed.includes('/')) return trimmed
  return dockerImagePlatformMap[trimmed]
}

const parseDockerPlatform = (platform: string): { os: string; architecture: string; variant?: string } => {
  const normalized = normalizePlatform(platform)
  if (!normalized) throw new Error(`Invalid docker platform: ${platform}`)
  const parts = normalized.split('/')
  if (parts.length < 2 || parts.length > 3) throw new Error(`Invalid docker platform: ${platform}`)
  const [os, architecture, variant] = parts
  return {
    os,
    architecture,
    ...(variant ? { variant } : {}),
  }
}

const mergeOutput = (payload: string | Uint8Array): string => String(payload).trim()

const runDocker = (args: string[]) =>
  spawnSyncImpl(['docker', ...args], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' })

const runnerImageRef = (options: { imageName: string; tag: string; digest?: string }) => {
  const digestPart = options.digest ? normalizeDigest(options.digest) : ''
  return `${options.imageName}:${options.tag}${digestPart ? `@${digestPart}` : ''}`
}

const validateRunnerImage = (options: {
  imageName: string
  tag: string
  digest?: string
  binary: string
  platform?: string
}) => {
  const imageRef = runnerImageRef(options)

  const inspectResult = runDocker(['image', 'inspect', '--format', '{{json .}}', imageRef])
  if (inspectResult.exitCode !== 0) {
    throw new Error(`Unable to inspect runner image ${imageRef}: ${mergeOutput(inspectResult.stderr)}`)
  }

  try {
    const parsed = JSON.parse(mergeOutput(inspectResult.stdout))
    const imageConfig = (Array.isArray(parsed) ? parsed[0] : parsed) as {
      os?: string
      OS?: string
      architecture?: string
      Architecture?: string
      Config?: Record<string, unknown> | null
    }

    const platform = options.platform ? parseDockerPlatform(options.platform) : undefined
    const imageOs = imageConfig.os ?? imageConfig.OS
    const imageArch = imageConfig.architecture ?? imageConfig.Architecture
    if (platform && imageOs && imageArch && (imageOs !== platform.os || imageArch !== platform.architecture)) {
      throw new Error(
        `Runner image ${imageRef} is for ${imageOs}/${imageArch}, expected ${platform.os}/${platform.architecture}`,
      )
    }

    if (!imageConfig.Config) {
      throw new Error(`Runner image ${imageRef} has no container config`)
    }
  } catch (error) {
    if (error instanceof Error) {
      throw error
    }
    throw new Error(`Failed to parse image config for ${imageRef}`)
  }

  const smokeTestArgs = ['run', '--rm', '--network', 'none']
  if (options.platform) {
    smokeTestArgs.push('--platform', options.platform)
  }
  smokeTestArgs.push('--entrypoint', options.binary, imageRef, '--help')
  const smokeTest = runDocker(smokeTestArgs)
  const stdout = mergeOutput(smokeTest.stdout)
  const stderr = mergeOutput(smokeTest.stderr)

  if (smokeTest.exitCode !== 0) {
    const output = stdout || stderr || '<no output>'
    throw new Error(
      `Runner image runtime check failed for ${imageRef} with entrypoint ${options.binary} (exit ${smokeTest.exitCode}): ${output}`,
    )
  }

  console.log(`Runner image runtime check passed for ${imageRef}`)
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
  runnerImageName?: string,
  runnerImageTag?: string,
  runnerImageDigest?: string,
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
  runnerImage.repository = runnerImageName || imageName
  runnerImage.tag = runnerImageTag || tag
  runnerImage.digest = runnerImageDigest || digest
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
  const digest = normalizeDigest(options.digest ?? inspectImageDigest(`${options.imageName}:${options.tag}`))
  const controlPlaneDigest = options.controlPlaneDigest ? normalizeDigest(options.controlPlaneDigest) : undefined
  const runnerImageTag = options.runnerImageTag ?? options.tag
  const runnerImageDigest = options.runnerImageDigest ? normalizeDigest(options.runnerImageDigest) : digest
  const runnerImageName = options.runnerImageName ?? options.imageName
  const runnerImageBinary = options.runnerImageBinary ?? defaultRunnerImageBinary
  const runnerImagePlatform = normalizePlatform(options.runnerImagePlatform)

  if (options.verifyRunnerImage) {
    validateRunnerImage({
      imageName: runnerImageName,
      tag: runnerImageTag,
      digest: runnerImageDigest,
      binary: runnerImageBinary,
      platform: runnerImagePlatform,
    })
  }

  if (options.verifyRunnerImageOnly) {
    return {
      tag: options.tag,
      digest,
      controlPlaneDigest,
      rolloutTimestamp: options.rolloutTimestamp,
      changed: {
        kustomization: false,
        service: false,
        worker: false,
        agentsValues: false,
      },
    }
  }

  const kustomizationPath = resolvePath(options.kustomizationPath ?? defaultKustomizationPath)
  const serviceManifestPath = resolvePath(options.serviceManifestPath ?? defaultServiceManifestPath)
  const workerManifestPath = resolvePath(options.workerManifestPath ?? defaultWorkerManifestPath)
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
        runnerImageName,
        runnerImageTag,
        runnerImageDigest,
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
  --runner-image-name <value>
  --runner-image-tag <value>
  --runner-image-digest <value>
  --runner-image-binary <value>
  --runner-image-platform <linux/amd64|linux/arm64>
  --verify-runner-image [true|false]
  --verify-runner-image-only [true|false]
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
    const nextValue = argv[i + 1]
    const nextValueLooksLikeValue = nextValue !== undefined && !nextValue.startsWith('--')

    if (flag === '--verify-runner-image') {
      if (inlineValue !== undefined) {
        options.verifyRunnerImage = parseBoolean(inlineValue)
        continue
      }

      if (nextValueLooksLikeValue && booleanFlagValues.has(nextValue.toLowerCase())) {
        options.verifyRunnerImage = parseBoolean(nextValue)
        i += 1
        continue
      }

      options.verifyRunnerImage = true
      continue
    }

    if (flag === '--verify-runner-image-only') {
      if (inlineValue !== undefined) {
        options.verifyRunnerImageOnly = parseBoolean(inlineValue)
        continue
      }

      if (nextValueLooksLikeValue && booleanFlagValues.has(nextValue.toLowerCase())) {
        options.verifyRunnerImageOnly = parseBoolean(nextValue)
        i += 1
        continue
      }

      options.verifyRunnerImageOnly = true
      continue
    }

    const expectsValue = true
    const value = inlineValue ?? (expectsValue && nextValueLooksLikeValue ? nextValue : undefined)

    if (expectsValue && value === undefined) {
      throw new Error(`Missing value for ${flag}`)
    }
    if (!inlineValue && expectsValue) {
      i += 1
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
      case '--runner-image-name':
        options.runnerImageName = value
        break
      case '--runner-image-tag':
        options.runnerImageTag = value
        break
      case '--runner-image-digest':
        options.runnerImageDigest = value
        break
      case '--runner-image-binary':
        options.runnerImageBinary = value
        break
      case '--runner-image-platform':
        options.runnerImagePlatform = value
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
    runnerImageName: parsed.runnerImageName ?? process.env.JANGAR_RUNNER_IMAGE_NAME,
    runnerImageTag: parsed.runnerImageTag ?? process.env.JANGAR_RUNNER_IMAGE_TAG,
    runnerImageDigest: parsed.runnerImageDigest ?? process.env.JANGAR_RUNNER_IMAGE_DIGEST,
    runnerImageBinary: parsed.runnerImageBinary ?? process.env.JANGAR_RUNNER_IMAGE_BINARY ?? defaultRunnerImageBinary,
    runnerImagePlatform: parsed.runnerImagePlatform ?? process.env.JANGAR_RUNNER_IMAGE_PLATFORM,
    verifyRunnerImage:
      parsed.verifyRunnerImage ??
      parseBoolean(process.env.JANGAR_VERIFY_RUNNER_IMAGE ?? process.env.JANGAR_RUNNER_IMAGE_VERIFY ?? 'false'),
    verifyRunnerImageOnly:
      parsed.verifyRunnerImageOnly ??
      parseBoolean(
        process.env.JANGAR_VERIFY_RUNNER_IMAGE_ONLY ?? process.env.JANGAR_RUNNER_IMAGE_VERIFY_ONLY ?? 'false',
      ),
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
  parseBoolean,
  setSpawnSync,
}
