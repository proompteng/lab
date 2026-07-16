#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

import { fatal, repoRoot } from '../shared/cli'
import { execGit } from '../shared/git'
import { inspectOciImageDigest } from '../shared/oci-digest'

const defaultRegistry = 'registry.ide-newton.ts.net'
const defaultRepository = 'lab/torghut'
const defaultManifestPath = 'argocd/applications/torghut/knative-service.yaml'
const defaultSchedulerManifestPath = 'argocd/applications/torghut/scheduler-deployment.yaml'
const defaultSimulationManifestPath = 'argocd/applications/torghut/knative-service-sim.yaml'
const defaultMigrationManifestPath = 'argocd/applications/torghut/db-migrations-job.yaml'
const defaultHistoricalSimulationWorkflowManifestPath =
  'argocd/applications/torghut/historical-simulation-workflowtemplate.yaml'
const defaultAnalysisRuntimeReadyManifestPath = 'argocd/applications/torghut/analysis-template-runtime-ready.yaml'
const defaultAnalysisActivityManifestPath = 'argocd/applications/torghut/analysis-template-activity.yaml'
const defaultAnalysisTeardownManifestPath = 'argocd/applications/torghut/analysis-template-teardown-clean.yaml'
const defaultAnalysisArtifactManifestPath = 'argocd/applications/torghut/analysis-template-artifact-bundle.yaml'
const defaultGeneratedResourceRetentionManifestPath =
  'argocd/applications/torghut/generated-resource-retention-cronjob.yaml'
const defaultBrokerEconomicLedgerReconciliationManifestPath =
  'argocd/applications/torghut/broker-economic-ledger-reconciliation-cronjob.yaml'
const defaultTigerBeetleSmokeManifestPath = 'argocd/applications/torghut/tigerbeetle-smoke-job.yaml'
const defaultHyperliquidRuntimeManifestPath = 'argocd/applications/torghut-hyperliquid-runtime/deployment.yaml'
const defaultHyperliquidRuntimeMigrationManifestPath =
  'argocd/applications/torghut-hyperliquid-runtime/db-migrations-job.yaml'
const defaultOptionsArchiveManifestPath = 'argocd/applications/torghut-options/archive/deployment.yaml'
const defaultOptionsCatalogManifestPath = 'argocd/applications/torghut-options/catalog/deployment.yaml'
const defaultOptionsEnricherManifestPath = 'argocd/applications/torghut-options/enricher/deployment.yaml'
const defaultRequiredImagePlatforms = 'linux/amd64,linux/arm64'

const digestPattern = /^sha256:[0-9a-f]{64}$/i

type UpdateManifestsOptions = {
  imageName: string
  digest: string
  version: string
  commit: string
  rolloutTimestamp: string
  manifestPath?: string
  schedulerManifestPath?: string
  simulationManifestPath?: string
  migrationManifestPath?: string
  historicalSimulationWorkflowManifestPath?: string
  analysisRuntimeReadyManifestPath?: string
  analysisActivityManifestPath?: string
  analysisTeardownManifestPath?: string
  analysisArtifactManifestPath?: string
  generatedResourceRetentionManifestPath?: string
  brokerEconomicLedgerReconciliationManifestPath?: string
  tigerBeetleSmokeManifestPath?: string
  hyperliquidRuntimeManifestPath?: string
  hyperliquidRuntimeMigrationManifestPath?: string
  includeOptionsManifests?: boolean
  optionsArchiveManifestPath?: string
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
  schedulerManifestPath?: string
  simulationManifestPath?: string
  migrationManifestPath?: string
  historicalSimulationWorkflowManifestPath?: string
  analysisRuntimeReadyManifestPath?: string
  analysisActivityManifestPath?: string
  analysisTeardownManifestPath?: string
  analysisArtifactManifestPath?: string
  generatedResourceRetentionManifestPath?: string
  brokerEconomicLedgerReconciliationManifestPath?: string
  tigerBeetleSmokeManifestPath?: string
  hyperliquidRuntimeManifestPath?: string
  hyperliquidRuntimeMigrationManifestPath?: string
  includeOptionsManifests?: boolean
  optionsArchiveManifestPath?: string
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

const replaceAllIfPresent = (source: string, pattern: RegExp, replacement: string): string => {
  if (!pattern.test(source)) {
    return source
  }
  pattern.lastIndex = 0
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

const upsertKnativeEnvValue = (source: string, envName: string, value: string): string => {
  const envPattern = new RegExp(`(- name:\\s*${escapeRegex(envName)}\\s*\\n\\s*value:\\s*)([^\\n]+)`)
  if (envPattern.test(source)) {
    return source.replace(envPattern, `$1${value}`)
  }

  const commitEnvPattern = /(- name:\s*TORGHUT_COMMIT\s*\n\s*value:\s*[^\n]+\n)/
  if (!commitEnvPattern.test(source)) {
    throw new Error(`Unable to locate TORGHUT_COMMIT env anchor for ${envName} in torghut manifest`)
  }

  return source.replace(commitEnvPattern, `$1            - name: ${envName}\n              value: ${value}\n`)
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
  updated = replaceIfPresent(updated, /(- name:\s*TORGHUT_VERSION\s*\n\s*value:\s*)([^\n]+)/, `$1${options.version}`)
  updated = replaceIfPresent(updated, /(- name:\s*TORGHUT_COMMIT\s*\n\s*value:\s*)([^\n]+)/, `$1${options.commit}`)
  updated = upsertKnativeEnvValue(updated, 'TORGHUT_IMAGE_DIGEST', options.digest)
  updated = upsertKnativeEnvValue(updated, 'TORGHUT_REQUIRED_IMAGE_PLATFORMS', defaultRequiredImagePlatforms)
  updated = upsertKnativeEnvValue(updated, 'TORGHUT_OBSERVED_IMAGE_PLATFORMS', defaultRequiredImagePlatforms)
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

  const imagePattern = new RegExp(
    `(\\n\\s*image:\\s*)${escapeRegex(options.imageName)}(?:@sha256:[0-9a-f]{64}|:[^\\s\\n]+)?`,
    'g',
  )
  let updated = replaceSingle(source, imagePattern, `$1${imageRef}`, label)
  updated = replaceAllIfPresent(
    updated,
    /(- name:\s*TORGHUT_VERSION\s*\n\s*value:\s*)([^\n]+)/g,
    `$1${options.version}`,
  )
  updated = replaceAllIfPresent(
    updated,
    /(- name:\s*TORGHUT_IMAGE_DIGEST\s*\n\s*value:\s*)([^\n]+)/g,
    `$1${options.digest}`,
  )
  updated = replaceAllIfPresent(updated, /(- name:\s*TORGHUT_COMMIT\s*\n\s*value:\s*)([^\n]+)/g, `$1${options.commit}`)
  updated = replaceAllIfPresent(
    updated,
    /(- name:\s*TORGHUT_REQUIRED_IMAGE_PLATFORMS\s*\n\s*value:\s*)([^\n]+)/g,
    `$1${defaultRequiredImagePlatforms}`,
  )
  updated = replaceAllIfPresent(
    updated,
    /(- name:\s*TORGHUT_OBSERVED_IMAGE_PLATFORMS\s*\n\s*value:\s*)([^\n]+)/g,
    `$1${defaultRequiredImagePlatforms}`,
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
  updated = replaceAllIfPresent(
    updated,
    new RegExp(`(\\n\\s*image:\\s*)${escapeRegex(options.imageName)}(?:@sha256:[0-9a-f]{64}|:[^\\s\\n]+)?`, 'g'),
    `$1${imageRef}`,
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
  const scheduler = updateImageOnlyManifest(
    options,
    options.schedulerManifestPath ?? defaultSchedulerManifestPath,
    'torghut-scheduler image reference',
  )
  const simulationService = updateTorghutManifest({
    ...options,
    manifestPath: options.simulationManifestPath ?? defaultSimulationManifestPath,
  })
  const migration = updateTorghutMigrationManifest(options)
  const historicalSimulationWorkflow = updateImageOnlyManifest(
    options,
    options.historicalSimulationWorkflowManifestPath ?? defaultHistoricalSimulationWorkflowManifestPath,
    'torghut-historical-simulation image reference',
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
  const generatedResourceRetention = updateImageOnlyManifest(
    options,
    options.generatedResourceRetentionManifestPath ?? defaultGeneratedResourceRetentionManifestPath,
    'torghut-generated-resource-retention image reference',
  )
  const brokerEconomicLedgerReconciliation = updateImageOnlyManifest(
    options,
    options.brokerEconomicLedgerReconciliationManifestPath ?? defaultBrokerEconomicLedgerReconciliationManifestPath,
    'torghut-broker-economic-ledger-reconciliation image reference',
  )
  const tigerBeetleSmoke = updateImageOnlyManifest(
    options,
    options.tigerBeetleSmokeManifestPath ?? defaultTigerBeetleSmokeManifestPath,
    'torghut-tigerbeetle-smoke image reference',
  )
  const hyperliquidRuntime = updateImageOnlyManifest(
    options,
    options.hyperliquidRuntimeManifestPath ?? defaultHyperliquidRuntimeManifestPath,
    'torghut-hyperliquid-runtime image reference',
  )
  const hyperliquidRuntimeMigration = updateImageOnlyManifest(
    options,
    options.hyperliquidRuntimeMigrationManifestPath ?? defaultHyperliquidRuntimeMigrationManifestPath,
    'torghut-hyperliquid-runtime-db-migrations image reference',
  )
  const includeOptionsManifests = options.includeOptionsManifests ?? true
  const optionalResults = includeOptionsManifests
    ? [
        updateVersionedDeploymentManifest(
          options,
          options.optionsArchiveManifestPath ?? defaultOptionsArchiveManifestPath,
          'torghut-options-archive',
          'TORGHUT_OPTIONS_VERSION',
          'TORGHUT_OPTIONS_COMMIT',
          'torghut-options-archive image reference',
        ),
        updateVersionedDeploymentManifest(
          options,
          options.optionsCatalogManifestPath ?? defaultOptionsCatalogManifestPath,
          'torghut-options-catalog',
          'TORGHUT_OPTIONS_VERSION',
          'TORGHUT_OPTIONS_COMMIT',
          'torghut-options-catalog image reference',
        ),
        updateVersionedDeploymentManifest(
          options,
          options.optionsEnricherManifestPath ?? defaultOptionsEnricherManifestPath,
          'torghut-options-enricher',
          'TORGHUT_OPTIONS_VERSION',
          'TORGHUT_OPTIONS_COMMIT',
          'torghut-options-enricher image reference',
        ),
      ]
    : []
  const changedPaths = [
    service,
    scheduler,
    simulationService,
    migration,
    historicalSimulationWorkflow,
    analysisRuntimeReady,
    analysisActivity,
    analysisTeardown,
    analysisArtifact,
    generatedResourceRetention,
    brokerEconomicLedgerReconciliation,
    tigerBeetleSmoke,
    hyperliquidRuntime,
    hyperliquidRuntimeMigration,
    ...optionalResults,
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
  --scheduler-manifest-path <path>
  --simulation-manifest-path <path>
  --migration-manifest-path <path>
  --historical-simulation-workflow-manifest-path <path>
  --analysis-runtime-ready-manifest-path <path>
  --analysis-activity-manifest-path <path>
  --analysis-teardown-manifest-path <path>
  --analysis-artifact-manifest-path <path>
  --generated-resource-retention-manifest-path <path>
  --broker-economic-ledger-reconciliation-manifest-path <path>
  --tigerbeetle-smoke-manifest-path <path>
  --hyperliquid-runtime-manifest-path <path>
  --hyperliquid-runtime-migration-manifest-path <path>
  --include-options-manifests
  --options-archive-manifest-path <path>
  --options-catalog-manifest-path <path>
  --options-enricher-manifest-path <path>`)
      process.exit(0)
    }

    if (arg === '--include-options-manifests') {
      options.includeOptionsManifests = true
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
      case '--scheduler-manifest-path':
        options.schedulerManifestPath = value
        break
      case '--simulation-manifest-path':
        options.simulationManifestPath = value
        break
      case '--migration-manifest-path':
        options.migrationManifestPath = value
        break
      case '--historical-simulation-workflow-manifest-path':
        options.historicalSimulationWorkflowManifestPath = value
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
      case '--generated-resource-retention-manifest-path':
        options.generatedResourceRetentionManifestPath = value
        break
      case '--broker-economic-ledger-reconciliation-manifest-path':
        options.brokerEconomicLedgerReconciliationManifestPath = value
        break
      case '--tigerbeetle-smoke-manifest-path':
        options.tigerBeetleSmokeManifestPath = value
        break
      case '--hyperliquid-runtime-manifest-path':
        options.hyperliquidRuntimeManifestPath = value
        break
      case '--hyperliquid-runtime-migration-manifest-path':
        options.hyperliquidRuntimeMigrationManifestPath = value
        break
      case '--include-options-manifests':
        options.includeOptionsManifests = true
        break
      case '--options-archive-manifest-path':
        options.optionsArchiveManifestPath = value
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

const parseOptionalBooleanEnv = (value: string | undefined): boolean | undefined => {
  if (value === undefined) return undefined
  return value === '1' || value.toLowerCase() === 'true'
}

const main = (cliOptions?: CliOptions) => {
  const parsed = cliOptions ?? parseArgs(process.argv.slice(2))
  const registry = parsed.registry ?? process.env.TORGHUT_IMAGE_REGISTRY ?? defaultRegistry
  const repository = parsed.repository ?? process.env.TORGHUT_IMAGE_REPOSITORY ?? defaultRepository
  const tag = parsed.tag ?? process.env.TORGHUT_IMAGE_TAG ?? execGit(['rev-parse', '--short=8', 'HEAD'])
  const imageName = `${registry}/${repository}`
  const digest = normalizeDigest(
    parsed.digest ?? process.env.TORGHUT_IMAGE_DIGEST ?? inspectOciImageDigest(`${imageName}:${tag}`),
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
    schedulerManifestPath: parsed.schedulerManifestPath ?? process.env.TORGHUT_SCHEDULER_MANIFEST_PATH,
    simulationManifestPath: parsed.simulationManifestPath ?? process.env.TORGHUT_SIMULATION_MANIFEST_PATH,
    migrationManifestPath: parsed.migrationManifestPath ?? process.env.TORGHUT_MIGRATION_MANIFEST_PATH,
    historicalSimulationWorkflowManifestPath:
      parsed.historicalSimulationWorkflowManifestPath ?? process.env.TORGHUT_HISTORICAL_SIMULATION_WORKFLOW_PATH,
    analysisRuntimeReadyManifestPath:
      parsed.analysisRuntimeReadyManifestPath ?? process.env.TORGHUT_ANALYSIS_RUNTIME_READY_MANIFEST_PATH,
    analysisActivityManifestPath:
      parsed.analysisActivityManifestPath ?? process.env.TORGHUT_ANALYSIS_ACTIVITY_MANIFEST_PATH,
    analysisTeardownManifestPath:
      parsed.analysisTeardownManifestPath ?? process.env.TORGHUT_ANALYSIS_TEARDOWN_MANIFEST_PATH,
    analysisArtifactManifestPath:
      parsed.analysisArtifactManifestPath ?? process.env.TORGHUT_ANALYSIS_ARTIFACT_MANIFEST_PATH,
    generatedResourceRetentionManifestPath:
      parsed.generatedResourceRetentionManifestPath ?? process.env.TORGHUT_GENERATED_RESOURCE_RETENTION_MANIFEST_PATH,
    brokerEconomicLedgerReconciliationManifestPath:
      parsed.brokerEconomicLedgerReconciliationManifestPath ??
      process.env.TORGHUT_BROKER_ECONOMIC_LEDGER_RECONCILIATION_MANIFEST_PATH,
    tigerBeetleSmokeManifestPath:
      parsed.tigerBeetleSmokeManifestPath ?? process.env.TORGHUT_TIGERBEETLE_SMOKE_MANIFEST_PATH,
    hyperliquidRuntimeManifestPath:
      parsed.hyperliquidRuntimeManifestPath ?? process.env.TORGHUT_HYPERLIQUID_RUNTIME_MANIFEST_PATH,
    hyperliquidRuntimeMigrationManifestPath:
      parsed.hyperliquidRuntimeMigrationManifestPath ?? process.env.TORGHUT_HYPERLIQUID_RUNTIME_MIGRATION_MANIFEST_PATH,
    includeOptionsManifests:
      parsed.includeOptionsManifests ?? parseOptionalBooleanEnv(process.env.TORGHUT_INCLUDE_OPTIONS_MANIFESTS),
    optionsArchiveManifestPath: parsed.optionsArchiveManifestPath ?? process.env.TORGHUT_OPTIONS_ARCHIVE_MANIFEST_PATH,
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
