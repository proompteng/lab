#!/usr/bin/env bun

import { resolve } from 'node:path'
import process from 'node:process'

import { fatal, repoRoot } from '../shared/cli'
import { execGit } from '../shared/git'
import {
  updateKustomizationImage,
  updateManifestAnnotation,
  upsertDeploymentContainerEnvValue,
} from './manifest-contract'

const defaultRegistry = 'registry.ide-newton.ts.net'
const defaultRepository = 'lab/jangar'
const defaultKustomizationPath = 'argocd/applications/jangar/kustomization.yaml'
const defaultServiceManifestPath = 'argocd/applications/jangar/deployment.yaml'

export type UpdateManifestsOptions = {
  imageName: string
  tag: string
  digest?: string
  sourceHeadSha?: string
  gitopsRevision?: string
  sourceCiRunId?: string
  sourceCiConclusion?: string
  manifestImageDigest?: string
  servingBuildCommit?: string
  servingImageDigest?: string
  rolloutTimestamp: string
  kustomizationPath?: string
  serviceManifestPath?: string
  workerManifestPath?: string
}

type CliOptions = {
  registry?: string
  repository?: string
  tag?: string
  digest?: string
  sourceHeadSha?: string
  gitopsRevision?: string
  sourceCiRunId?: string
  sourceCiConclusion?: string
  manifestImageDigest?: string
  servingBuildCommit?: string
  servingImageDigest?: string
  rolloutTimestamp?: string
  kustomizationPath?: string
  serviceManifestPath?: string
  workerManifestPath?: string
}

const resolvePath = (path: string) => resolve(repoRoot, path)

const normalizeDigest = (digest: string): string => {
  const trimmed = digest.trim()
  if (!trimmed) return trimmed
  const atIndex = trimmed.lastIndexOf('@')
  return atIndex >= 0 ? trimmed.slice(atIndex + 1) : trimmed
}

const normalizeOptional = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

const requireDigest = (digest: string | undefined): string => {
  const normalized = normalizeOptional(digest)
  if (!normalized) {
    throw new Error('Jangar manifest updates require an explicit image digest from the release contract')
  }
  return normalized
}

type SourceServingProofEnv = {
  sourceHeadSha?: string
  gitopsRevision?: string
  sourceCiRunId?: string
  sourceCiConclusion?: string
  manifestImageDigest?: string
  servingBuildCommit?: string
  servingImageDigest?: string
}

const buildSourceServingProofEnv = (proof: SourceServingProofEnv) =>
  Object.fromEntries(
    Object.entries({
      JANGAR_SOURCE_HEAD_SHA: normalizeOptional(proof.sourceHeadSha),
      JANGAR_GITOPS_REVISION: normalizeOptional(proof.gitopsRevision),
      JANGAR_SOURCE_CI_RUN_ID: normalizeOptional(proof.sourceCiRunId),
      JANGAR_SOURCE_CI_CONCLUSION: normalizeOptional(proof.sourceCiConclusion),
      JANGAR_MANIFEST_IMAGE_DIGEST: normalizeOptional(proof.manifestImageDigest),
      JANGAR_SERVING_BUILD_COMMIT: normalizeOptional(proof.servingBuildCommit),
      JANGAR_SERVING_IMAGE_DIGEST: normalizeOptional(proof.servingImageDigest),
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )

const upsertDeploymentEnvValues = (manifestPath: string, containerName: string, values: Record<string, string>) => {
  const changed: Record<string, boolean> = {}
  for (const [name, value] of Object.entries(values)) {
    changed[name] = upsertDeploymentContainerEnvValue(manifestPath, containerName, name, value)
    if (changed[name]) {
      console.log(`Updated ${manifestPath} env ${name} to ${value}`)
    } else {
      console.warn(`Warning: ${manifestPath} env ${name} was not updated; manifest may already match.`)
    }
  }
  return changed
}

export const updateJangarManifests = (options: UpdateManifestsOptions) => {
  const kustomizationPath = resolvePath(options.kustomizationPath ?? defaultKustomizationPath)
  const serviceManifestPath = resolvePath(options.serviceManifestPath ?? defaultServiceManifestPath)
  const workerManifestPath = options.workerManifestPath ? resolvePath(options.workerManifestPath) : null
  const digest = normalizeDigest(requireDigest(options.digest))
  const manifestImageDigest = normalizeOptional(options.manifestImageDigest) ?? digest
  const servingBuildCommit = normalizeOptional(options.servingBuildCommit) ?? normalizeOptional(options.sourceHeadSha)
  const servingImageDigest = normalizeOptional(options.servingImageDigest) ?? digest

  const kustomizationChanged = updateKustomizationImage(kustomizationPath, options.imageName, options.tag, digest)
  if (!kustomizationChanged) {
    console.warn('Warning: jangar kustomization was not updated; manifest may already match the requested image.')
  } else {
    console.log(`Updated ${kustomizationPath} with tag ${options.tag} and digest ${digest}`)
  }

  const serviceChanged = updateManifestAnnotation(
    serviceManifestPath,
    'deploy.knative.dev/rollout',
    options.rolloutTimestamp,
  )
  if (!serviceChanged) {
    console.warn('Warning: jangar service rollout annotation was not updated; manifest may already match.')
  } else {
    console.log(`Updated ${serviceManifestPath} annotation deploy.knative.dev/rollout to ${options.rolloutTimestamp}`)
  }

  const sourceHeadSha = normalizeOptional(options.sourceHeadSha)
  const gitopsRevision = normalizeOptional(options.gitopsRevision)
  const sourceServingProofEnv = buildSourceServingProofEnv({
    sourceHeadSha,
    gitopsRevision,
    sourceCiRunId: options.sourceCiRunId,
    sourceCiConclusion: options.sourceCiConclusion,
    manifestImageDigest,
    servingBuildCommit,
    servingImageDigest,
  })
  const sourceServingProofEnvChanged = upsertDeploymentEnvValues(serviceManifestPath, 'app', sourceServingProofEnv)

  const workerChanged = workerManifestPath
    ? updateManifestAnnotation(workerManifestPath, 'kubectl.kubernetes.io/restartedAt', options.rolloutTimestamp)
    : false
  if (workerManifestPath) {
    if (!workerChanged) {
      console.warn('Warning: jangar worker rollout annotation was not updated; manifest may already match.')
    } else {
      console.log(
        `Updated ${workerManifestPath} annotation kubectl.kubernetes.io/restartedAt to ${options.rolloutTimestamp}`,
      )
    }
  }
  return {
    tag: options.tag,
    digest,
    rolloutTimestamp: options.rolloutTimestamp,
    changed: {
      kustomization: kustomizationChanged,
      service: serviceChanged,
      sourceHeadShaEnv: sourceServingProofEnvChanged.JANGAR_SOURCE_HEAD_SHA ?? false,
      gitopsRevisionEnv: sourceServingProofEnvChanged.JANGAR_GITOPS_REVISION ?? false,
      sourceCiRunIdEnv: sourceServingProofEnvChanged.JANGAR_SOURCE_CI_RUN_ID ?? false,
      sourceCiConclusionEnv: sourceServingProofEnvChanged.JANGAR_SOURCE_CI_CONCLUSION ?? false,
      manifestImageDigestEnv: sourceServingProofEnvChanged.JANGAR_MANIFEST_IMAGE_DIGEST ?? false,
      servingBuildCommitEnv: sourceServingProofEnvChanged.JANGAR_SERVING_BUILD_COMMIT ?? false,
      servingImageDigestEnv: sourceServingProofEnvChanged.JANGAR_SERVING_IMAGE_DIGEST ?? false,
      worker: workerChanged,
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
  --source-head-sha <sha>
  --gitops-revision <sha>
  --source-ci-run-id <id>
  --source-ci-conclusion <conclusion>
  --manifest-image-digest <digest>
  --serving-build-commit <sha>
  --serving-image-digest <digest>
  --rollout-timestamp <ISO8601>
  --kustomization-path <path>
  --service-manifest-path <path>
  --worker-manifest-path <path>      Optional legacy worker manifest to update`)
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
      case '--source-head-sha':
        options.sourceHeadSha = value
        break
      case '--gitops-revision':
        options.gitopsRevision = value
        break
      case '--source-ci-run-id':
        options.sourceCiRunId = value
        break
      case '--source-ci-conclusion':
        options.sourceCiConclusion = value
        break
      case '--manifest-image-digest':
        options.manifestImageDigest = value
        break
      case '--serving-build-commit':
        options.servingBuildCommit = value
        break
      case '--serving-image-digest':
        options.servingImageDigest = value
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
    sourceHeadSha: parsed.sourceHeadSha ?? process.env.JANGAR_SOURCE_HEAD_SHA ?? process.env.JANGAR_COMMIT,
    gitopsRevision:
      parsed.gitopsRevision ??
      process.env.JANGAR_GITOPS_REVISION ??
      process.env.ARGOCD_APP_REVISION ??
      process.env.ARGOCD_REVISION,
    sourceCiRunId: parsed.sourceCiRunId ?? process.env.JANGAR_SOURCE_CI_RUN_ID ?? process.env.GITHUB_RUN_ID,
    sourceCiConclusion: parsed.sourceCiConclusion ?? process.env.JANGAR_SOURCE_CI_CONCLUSION,
    manifestImageDigest: parsed.manifestImageDigest ?? process.env.JANGAR_MANIFEST_IMAGE_DIGEST,
    servingBuildCommit:
      parsed.servingBuildCommit ??
      process.env.JANGAR_SERVING_BUILD_COMMIT ??
      process.env.JANGAR_SOURCE_HEAD_SHA ??
      process.env.JANGAR_COMMIT,
    servingImageDigest: parsed.servingImageDigest ?? process.env.JANGAR_SERVING_IMAGE_DIGEST,
    rolloutTimestamp,
    kustomizationPath: parsed.kustomizationPath ?? process.env.JANGAR_KUSTOMIZATION_PATH,
    serviceManifestPath: parsed.serviceManifestPath ?? process.env.JANGAR_SERVICE_MANIFEST,
    workerManifestPath: parsed.workerManifestPath ?? process.env.JANGAR_WORKER_MANIFEST,
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
  updateKustomizationImage,
  updateManifestAnnotation,
}
