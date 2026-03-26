#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

import { fatal, repoRoot } from '../shared/cli'
import { inspectImageDigest } from '../shared/docker'
import { execGit } from '../shared/git'

const defaultRegistry = 'registry.ide-newton.ts.net'
const defaultRepository = 'lab/torghut'
const defaultManifestPath = 'argocd/applications/torghut/knative-service.yaml'
const defaultSimpleManifestPath = 'argocd/applications/torghut/knative-service-simple.yaml'
const defaultSimulationManifestPath = 'argocd/applications/torghut/knative-service-sim.yaml'
const defaultMigrationManifestPath = 'argocd/applications/torghut/db-migrations-job.yaml'
const defaultLeanRunnerManifestPath = 'argocd/applications/torghut/lean-runner-deployment.yaml'
const defaultHistoricalSimulationWorkflowManifestPath =
  'argocd/applications/torghut/historical-simulation-workflowtemplate.yaml'
const defaultEmpiricalPromotionWorkflowManifestPath =
  'argocd/applications/torghut/empirical-promotion-workflowtemplate.yaml'
const defaultAnalysisRuntimeReadyManifestPath = 'argocd/applications/torghut/analysis-template-runtime-ready.yaml'
const defaultAnalysisActivityManifestPath = 'argocd/applications/torghut/analysis-template-activity.yaml'
const defaultAnalysisTeardownManifestPath = 'argocd/applications/torghut/analysis-template-teardown-clean.yaml'
const defaultAnalysisArtifactManifestPath = 'argocd/applications/torghut/analysis-template-artifact-bundle.yaml'
const defaultEmpiricalBackfillManifestPath = 'argocd/applications/torghut/empirical-jobs-backfill-job.yaml'
const defaultForecastManifestPath = 'argocd/applications/torghut-forecast/deployment.yaml'
const defaultForecastSimulationManifestPath = 'argocd/applications/torghut-forecast/sim/deployment.yaml'
const defaultOptionsCatalogManifestPath = 'argocd/applications/torghut-options/catalog/deployment.yaml'
const defaultOptionsEnricherManifestPath = 'argocd/applications/torghut-options/enricher/deployment.yaml'

const digestPattern = /^sha256:[0-9a-f]{64}$/i

type UpdateManifestsOptions = {
  imageName: string
  digest: string
  version: string
  commit: string
  rolloutTimestamp: string
  manifestPath?: string
  simpleManifestPath?: string
  simulationManifestPath?: string
  migrationManifestPath?: string
  leanRunnerManifestPath?: string
  historicalSimulationWorkflowManifestPath?: string
  empiricalPromotionWorkflowManifestPath?: string
  analysisRuntimeReadyManifestPath?: string
  analysisActivityManifestPath?: string
  analysisTeardownManifestPath?: string
  analysisArtifactManifestPath?: string
  empiricalBackfillManifestPath?: string
  forecastManifestPath?: string
  forecastSimulationManifestPath?: string
  optionsCatalogManifestPath?: string
  optionsEnricherManifestPath?: string
}

type CliOptions = {
  registry?: string
  repository?: string
  tag?: string
  digest?: string
  version?: string
  commit?: string
  rolloutTimestamp?: string
  manifestPath?: string
  simpleManifestPath?: string
  simulationManifestPath?: string
  migrationManifestPath?: string
  leanRunnerManifestPath?: string
  historicalSimulationWorkflowManifestPath?: string
  empiricalPromotionWorkflowManifestPath?: string
  analysisRuntimeReadyManifestPath?: string
  analysisActivityManifestPath?: string
  analysisTeardownManifestPath?: string
  analysisArtifactManifestPath?: string
  empiricalBackfillManifestPath?: string
  forecastManifestPath?: string
  forecastSimulationManifestPath?: string
  optionsCatalogManifestPath?: string
  optionsEnricherManifestPath?: string
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
    throw new Error(`Unable to locate ${label} in torghut manifest`)
  }
  return source.replace(pattern, replacement)
}

const replaceIfPresent = (source: string, pattern: RegExp, replacement: string): string => {
  if (!pattern.test(source)) {
    return source
  }
  return source.replace(pattern, replacement)
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const upsertKnativeRolloutTimestamp = (source: string, rolloutTimestamp: string): string => {
  const annotationPattern = /(client\.knative\.dev\/updateTimestamp:\s*)(?:"[^"]*"|'[^']*'|[^\n]+)/
  if (annotationPattern.test(source)) {
    return source.replace(annotationPattern, `$1"${rolloutTimestamp}"`)
  }

  const annotationsBlockPattern = /(\n\s*template:\n\s*metadata:\n\s*annotations:\n)/
  if (!annotationsBlockPattern.test(source)) {
    throw new Error('Unable to locate rollout timestamp annotation block in torghut manifest')
  }

  return source.replace(
    annotationsBlockPattern,
    `$1        client.knative.dev/updateTimestamp: "${rolloutTimestamp}"\n`,
  )
}

const updateTorghutManifest = (options: UpdateManifestsOptions) => {
  const manifestPath = resolvePath(options.manifestPath ?? defaultManifestPath)
  const source = readFileSync(manifestPath, 'utf8')
  const imageRef = `${options.imageName}@${options.digest}`

  let updated = source
  updated = upsertKnativeRolloutTimestamp(updated, options.rolloutTimestamp)
  updated = replaceSingle(
    updated,
    /(- name:\s*user-container[\s\S]*?\n\s*image:\s*)([^\n]+)/,
    `$1${imageRef}`,
    'user-container image reference',
  )
  updated = replaceIfPresent(
    updated,
    /(- name:\s*TORGHUT_VERSION\s*\n\s*value:\s*)([^\n]+)/,
    `$1${options.version}`,
  )
  updated = replaceIfPresent(
    updated,
    /(- name:\s*TORGHUT_COMMIT\s*\n\s*value:\s*)([^\n]+)/,
    `$1${options.commit}`,
  )
  updated = updated.replace(/^\s*serving\.knative\.dev\/lastModifier:\s*[^\n]+\n/gm, '')

  if (updated !== source) {
    writeFileSync(manifestPath, updated, 'utf8')
  }

  return {
    manifestPath,
    imageRef,
    changed: updated !== source,
  }
}

const updateTorghutMigrationManifest = (options: UpdateManifestsOptions) => {
  const manifestPath = resolvePath(options.migrationManifestPath ?? defaultMigrationManifestPath)
  const source = readFileSync(manifestPath, 'utf8')
  const imageRef = `${options.imageName}@${options.digest}`

  const updated = replaceSingle(
    source,
    /(- name:\s*migrate[\s\S]*?\n\s*image:\s*)([^\n]+)/,
    `$1${imageRef}`,
    'torghut-db-migrations image reference',
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

const updateImageOnlyManifest = (options: UpdateManifestsOptions, manifestPathValue: string, label: string) => {
  const manifestPath = resolvePath(manifestPathValue)
  const source = readFileSync(manifestPath, 'utf8')
  const imageRef = `${options.imageName}@${options.digest}`

  const updated = replaceSingle(source, /(\n\s*image:\s*)([^\n]+)/, `$1${imageRef}`, label)

  if (updated !== source) {
    writeFileSync(manifestPath, updated, 'utf8')
  }

  return {
    manifestPath,
    imageRef,
    changed: updated !== source,
  }
}

const updateVersionedDeploymentManifest = (
  options: UpdateManifestsOptions,
  manifestPathValue: string,
  containerName: string,
  versionEnvName: string,
  commitEnvName: string,
  label: string,
) => {
  const manifestPath = resolvePath(manifestPathValue)
  const source = readFileSync(manifestPath, 'utf8')
  const imageRef = `${options.imageName}@${options.digest}`

  let updated = replaceSingle(
    source,
    new RegExp(`(- name:\\s*${escapeRegex(containerName)}[\\s\\S]*?\\n\\s*image:\\s*)([^\\n]+)`),
    `$1${imageRef}`,
    label,
  )
  updated = replaceSingle(
    updated,
    new RegExp(`(- name:\\s*${escapeRegex(versionEnvName)}\\s*\\n\\s*value:\\s*)([^\\n]+)`),
    `$1${options.version}`,
    versionEnvName,
  )
  updated = replaceSingle(
    updated,
    new RegExp(`(- name:\\s*${escapeRegex(commitEnvName)}\\s*\\n\\s*value:\\s*)([^\\n]+)`),
    `$1${options.commit}`,
    commitEnvName,
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

const updateTorghutManifests = (options: UpdateManifestsOptions) => {
  const service = updateTorghutManifest(options)
  const simpleService = updateTorghutManifest({
    ...options,
    manifestPath: options.simpleManifestPath ?? defaultSimpleManifestPath,
  })
  const simulationService = updateTorghutManifest({
    ...options,
    manifestPath: options.simulationManifestPath ?? defaultSimulationManifestPath,
  })
  const migration = updateTorghutMigrationManifest(options)
  const leanRunner = updateImageOnlyManifest(
    options,
    options.leanRunnerManifestPath ?? defaultLeanRunnerManifestPath,
    'torghut-lean-runner image reference',
  )
  const historicalSimulationWorkflow = updateImageOnlyManifest(
    options,
    options.historicalSimulationWorkflowManifestPath ?? defaultHistoricalSimulationWorkflowManifestPath,
    'torghut-historical-simulation image reference',
  )
  const empiricalPromotionWorkflow = updateImageOnlyManifest(
    options,
    options.empiricalPromotionWorkflowManifestPath ?? defaultEmpiricalPromotionWorkflowManifestPath,
    'torghut-empirical-promotion image reference',
  )
  const analysisRuntimeReady = updateImageOnlyManifest(
    options,
    options.analysisRuntimeReadyManifestPath ?? defaultAnalysisRuntimeReadyManifestPath,
    'torghut-simulation-runtime-ready image reference',
  )
  const analysisActivity = updateImageOnlyManifest(
    options,
    options.analysisActivityManifestPath ?? defaultAnalysisActivityManifestPath,
    'torghut-simulation-activity image reference',
  )
  const analysisTeardown = updateImageOnlyManifest(
    options,
    options.analysisTeardownManifestPath ?? defaultAnalysisTeardownManifestPath,
    'torghut-simulation-teardown-clean image reference',
  )
  const analysisArtifact = updateImageOnlyManifest(
    options,
    options.analysisArtifactManifestPath ?? defaultAnalysisArtifactManifestPath,
    'torghut-simulation-artifact-bundle image reference',
  )
  const empiricalBackfill = updateImageOnlyManifest(
    options,
    options.empiricalBackfillManifestPath ?? defaultEmpiricalBackfillManifestPath,
    'torghut-empirical-jobs-backfill image reference',
  )
  const forecast = updateImageOnlyManifest(
    options,
    options.forecastManifestPath ?? defaultForecastManifestPath,
    'torghut-forecast image reference',
  )
  const forecastSimulation = updateImageOnlyManifest(
    options,
    options.forecastSimulationManifestPath ?? defaultForecastSimulationManifestPath,
    'torghut-forecast-sim image reference',
  )
  const optionsCatalog = updateVersionedDeploymentManifest(
    options,
    options.optionsCatalogManifestPath ?? defaultOptionsCatalogManifestPath,
    'torghut-options-catalog',
    'TORGHUT_OPTIONS_VERSION',
    'TORGHUT_OPTIONS_COMMIT',
    'torghut-options-catalog image reference',
  )
  const optionsEnricher = updateVersionedDeploymentManifest(
    options,
    options.optionsEnricherManifestPath ?? defaultOptionsEnricherManifestPath,
    'torghut-options-enricher',
    'TORGHUT_OPTIONS_VERSION',
    'TORGHUT_OPTIONS_COMMIT',
    'torghut-options-enricher image reference',
  )
  const changedPaths = [
    service,
    simpleService,
    simulationService,
    migration,
    leanRunner,
    historicalSimulationWorkflow,
    empiricalPromotionWorkflow,
    analysisRuntimeReady,
    analysisActivity,
    analysisTeardown,
    analysisArtifact,
    empiricalBackfill,
    forecast,
    forecastSimulation,
    optionsCatalog,
    optionsEnricher,
  ]
    .filter((entry) => entry.changed)
    .map((entry) => entry.manifestPath)
  return {
    imageRef: service.imageRef,
    changed: changedPaths.length > 0,
    changedPaths,
  }
}

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = {}

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bun run packages/scripts/src/torghut/update-manifests.ts [options]

Options:
  --registry <value>
  --repository <value>
  --tag <value>
  --digest <sha256:...>
  --version <value>
  --commit <sha40>
  --rollout-timestamp <ISO8601>
  --manifest-path <path>
  --simple-manifest-path <path>
  --simulation-manifest-path <path>
  --migration-manifest-path <path>
  --lean-runner-manifest-path <path>
  --historical-simulation-workflow-manifest-path <path>
  --empirical-promotion-workflow-manifest-path <path>
  --analysis-runtime-ready-manifest-path <path>
  --analysis-activity-manifest-path <path>
  --analysis-teardown-manifest-path <path>
  --analysis-artifact-manifest-path <path>
  --empirical-backfill-manifest-path <path>
  --forecast-manifest-path <path>
  --forecast-simulation-manifest-path <path>
  --options-catalog-manifest-path <path>
  --options-enricher-manifest-path <path>`)
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
      case '--rollout-timestamp':
        options.rolloutTimestamp = value
        break
      case '--manifest-path':
        options.manifestPath = value
        break
      case '--simple-manifest-path':
        options.simpleManifestPath = value
        break
      case '--simulation-manifest-path':
        options.simulationManifestPath = value
        break
      case '--migration-manifest-path':
        options.migrationManifestPath = value
        break
      case '--lean-runner-manifest-path':
        options.leanRunnerManifestPath = value
        break
      case '--historical-simulation-workflow-manifest-path':
        options.historicalSimulationWorkflowManifestPath = value
        break
      case '--empirical-promotion-workflow-manifest-path':
        options.empiricalPromotionWorkflowManifestPath = value
        break
      case '--analysis-runtime-ready-manifest-path':
        options.analysisRuntimeReadyManifestPath = value
        break
      case '--analysis-activity-manifest-path':
        options.analysisActivityManifestPath = value
        break
      case '--analysis-teardown-manifest-path':
        options.analysisTeardownManifestPath = value
        break
      case '--analysis-artifact-manifest-path':
        options.analysisArtifactManifestPath = value
        break
      case '--empirical-backfill-manifest-path':
        options.empiricalBackfillManifestPath = value
        break
      case '--forecast-manifest-path':
        options.forecastManifestPath = value
        break
      case '--forecast-simulation-manifest-path':
        options.forecastSimulationManifestPath = value
        break
      case '--options-catalog-manifest-path':
        options.optionsCatalogManifestPath = value
        break
      case '--options-enricher-manifest-path':
        options.optionsEnricherManifestPath = value
        break
      default:
        throw new Error(`Unknown option: ${flag}`)
    }
  }

  return options
}

export const main = (cliOptions?: CliOptions) => {
  const parsed = cliOptions ?? parseArgs(process.argv.slice(2))
  const registry = parsed.registry ?? process.env.TORGHUT_IMAGE_REGISTRY ?? defaultRegistry
  const repository = parsed.repository ?? process.env.TORGHUT_IMAGE_REPOSITORY ?? defaultRepository
  const tag = parsed.tag ?? process.env.TORGHUT_IMAGE_TAG ?? execGit(['rev-parse', '--short=8', 'HEAD'])
  const imageName = `${registry}/${repository}`
  const digest = normalizeDigest(
    parsed.digest ?? process.env.TORGHUT_IMAGE_DIGEST ?? inspectImageDigest(`${imageName}:${tag}`),
  )

  if (!digestPattern.test(digest)) {
    throw new Error(`Resolved digest '${digest}' is invalid; expected sha256:<64 hex>`)
  }

  const version = parsed.version ?? process.env.TORGHUT_VERSION ?? execGit(['describe', '--tags', '--always'])
  const commit = parsed.commit ?? process.env.TORGHUT_COMMIT ?? execGit(['rev-parse', 'HEAD'])
  const rolloutTimestamp = parsed.rolloutTimestamp ?? process.env.TORGHUT_ROLLOUT_TIMESTAMP ?? new Date().toISOString()

  const result = updateTorghutManifests({
    imageName,
    digest,
    version,
    commit,
    rolloutTimestamp,
    manifestPath: parsed.manifestPath ?? process.env.TORGHUT_MANIFEST_PATH,
    simpleManifestPath: parsed.simpleManifestPath ?? process.env.TORGHUT_SIMPLE_MANIFEST_PATH,
    simulationManifestPath: parsed.simulationManifestPath ?? process.env.TORGHUT_SIMULATION_MANIFEST_PATH,
    migrationManifestPath: parsed.migrationManifestPath ?? process.env.TORGHUT_MIGRATION_MANIFEST_PATH,
    leanRunnerManifestPath: parsed.leanRunnerManifestPath ?? process.env.TORGHUT_LEAN_RUNNER_MANIFEST_PATH,
    historicalSimulationWorkflowManifestPath:
      parsed.historicalSimulationWorkflowManifestPath ?? process.env.TORGHUT_HISTORICAL_SIMULATION_WORKFLOW_PATH,
    empiricalPromotionWorkflowManifestPath:
      parsed.empiricalPromotionWorkflowManifestPath ?? process.env.TORGHUT_EMPIRICAL_PROMOTION_WORKFLOW_PATH,
    analysisRuntimeReadyManifestPath:
      parsed.analysisRuntimeReadyManifestPath ?? process.env.TORGHUT_ANALYSIS_RUNTIME_READY_MANIFEST_PATH,
    analysisActivityManifestPath:
      parsed.analysisActivityManifestPath ?? process.env.TORGHUT_ANALYSIS_ACTIVITY_MANIFEST_PATH,
    analysisTeardownManifestPath:
      parsed.analysisTeardownManifestPath ?? process.env.TORGHUT_ANALYSIS_TEARDOWN_MANIFEST_PATH,
    analysisArtifactManifestPath:
      parsed.analysisArtifactManifestPath ?? process.env.TORGHUT_ANALYSIS_ARTIFACT_MANIFEST_PATH,
    empiricalBackfillManifestPath:
      parsed.empiricalBackfillManifestPath ?? process.env.TORGHUT_EMPIRICAL_BACKFILL_MANIFEST_PATH,
    forecastManifestPath: parsed.forecastManifestPath ?? process.env.TORGHUT_FORECAST_MANIFEST_PATH,
    forecastSimulationManifestPath:
      parsed.forecastSimulationManifestPath ?? process.env.TORGHUT_FORECAST_SIMULATION_MANIFEST_PATH,
    optionsCatalogManifestPath: parsed.optionsCatalogManifestPath ?? process.env.TORGHUT_OPTIONS_CATALOG_MANIFEST_PATH,
    optionsEnricherManifestPath:
      parsed.optionsEnricherManifestPath ?? process.env.TORGHUT_OPTIONS_ENRICHER_MANIFEST_PATH,
  })

  if (result.changed) {
    console.log(`Updated ${result.changedPaths.join(', ')} with ${result.imageRef}`)
  } else {
    console.log(`No manifest changes required for ${result.imageRef}`)
  }
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    fatal('Failed to update torghut manifests', error)
  }
}

export const __private = {
  normalizeDigest,
  parseArgs,
  replaceSingle,
  updateTorghutManifest,
  updateTorghutMigrationManifest,
  updateImageOnlyManifest,
  updateVersionedDeploymentManifest,
  updateTorghutManifests,
}
