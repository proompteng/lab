#!/usr/bin/env bun

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'

type PackageJson = {
  readonly name?: string
  readonly version?: string
  readonly dependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
  readonly files?: string[]
  readonly scripts?: Record<string, string>
}

type GateStatus = {
  readonly passed: boolean
  readonly detail: string
}

type SemanticConcernEvidence = {
  readonly id: string
  readonly concern: string
  readonly defaultChoiceRequired: boolean
  readonly status: 'release-gated' | 'documented-tradeoff'
  readonly gateRefs: readonly string[]
  readonly evidenceRefs: readonly string[]
  readonly missingEvidenceRefs: readonly string[]
  readonly passed: boolean
}

type ProductionEvidence = {
  readonly schemaVersion: 1
  readonly package: {
    readonly name: string
    readonly version: string
  }
  readonly generatedAt: string
  readonly git: {
    readonly sha: string | null
    readonly branch: string | null
  }
  readonly runtime: {
    readonly bunVersion: string
    readonly platform: NodeJS.Platform
    readonly arch: string
  }
  readonly packageBoundary: {
    readonly files: readonly string[]
    readonly forbiddenDependencies: readonly string[]
    readonly forbiddenDependencyHits: readonly string[]
    readonly nativeArtifactHits: readonly string[]
    readonly forbiddenPathHits: readonly string[]
  }
  readonly evidence: {
    readonly replayFixtureCount: number
    readonly replayCorpusFixtureCount: number
    readonly replayCorpusReportPresent: boolean
    readonly replayCorpusReportPath: string
    readonly replayCorpusReportPassed: boolean
    readonly replayCorpusCoverageTags: readonly string[]
    readonly replayCorpusCommandKinds: readonly string[]
    readonly replayCorpusExternalOperationKinds: readonly string[]
    readonly replayCorpusHistoryEventTypes: readonly string[]
    readonly loadReportPresent: boolean
    readonly loadReportPath: string
    readonly loadReportPassed: boolean
    readonly loadScenarioCoverage: Record<string, number>
    readonly asyncFuzzReportPresent: boolean
    readonly asyncFuzzReportPath: string
    readonly asyncFuzzSeedCount: number
    readonly asyncFuzzOperationCount: number
    readonly asyncFuzzOperationCoverage: Record<string, number>
    readonly soakReportPresent: boolean
    readonly soakReportPath: string
    readonly soakIterationCount: number
    readonly soakFailureModeCoverage: Record<string, number>
    readonly soakDurationMs: number
    readonly soakElapsedMs: number
    readonly soakMemorySummary: SoakMemorySummary | null
    readonly productionUsageServiceCount: number
    readonly productionUsageServices: readonly ProductionUsageServiceEvidence[]
    readonly productionUsageObservabilityRefs: readonly string[]
    readonly productionUsageMissingRefs: readonly string[]
    readonly longSoakWorkflowPresent: boolean
    readonly longSoakWorkflowPath: string
    readonly docsHash: string
  }
  readonly gates: Record<string, GateStatus>
  readonly semanticConcerns: readonly SemanticConcernEvidence[]
  readonly defaultChoice: {
    readonly recommended: boolean
    readonly scope: string
    readonly supportModel: string
    readonly minimumReplayFixtures: number
    readonly minimumAsyncFuzzSeeds: number
    readonly minimumAsyncFuzzOperations: number
    readonly minimumLoadWorkflows: number
    readonly minimumLoadPeakConcurrency: number
    readonly minimumProductionServices: number
    readonly minimumSoakIterations: number
    readonly minimumSoakDurationMs: number
    readonly semanticConcernIds: readonly string[]
    readonly blockers: readonly string[]
  }
}

type ReplayCorpusReport = {
  readonly passed?: boolean
  readonly minimumFixtures?: number
  readonly fixtureCount?: number
  readonly results?: readonly { readonly passed?: boolean; readonly featureTags?: readonly string[] }[]
  readonly coverage?: {
    readonly featureTags?: readonly string[]
    readonly commandKinds?: readonly string[]
    readonly externalOperationKinds?: readonly string[]
    readonly historyEventTypes?: readonly string[]
    readonly temporalServerVersions?: readonly string[]
    readonly sdkVersions?: readonly string[]
    readonly bunVersions?: readonly string[]
    readonly payloadCodecProfiles?: readonly string[]
  }
}

type WorkerLoadReport = {
  readonly config?: {
    readonly workflowCount?: number
    readonly stickyHitRatioTarget?: number
    readonly workflowPollP95TargetMs?: number
    readonly activityPollP95TargetMs?: number
    readonly throughputFloorPerSecond?: number
  }
  readonly stats?: {
    readonly submitted?: number
    readonly completed?: number
  }
  readonly metrics?: {
    readonly stickyHitRatio?: number
    readonly workflowThroughputPerSecond?: number
    readonly workflowPollLatency?: { readonly p95?: number }
    readonly activityPollLatency?: { readonly p95?: number }
  }
  readonly scenarioCoverage?: Record<string, number>
}

type AsyncFuzzReport = {
  readonly passed?: boolean
  readonly seedCount?: number
  readonly operationCount?: number
  readonly operationCoverage?: Record<string, number>
  readonly mismatchChecks?: number
  readonly elapsedMs?: number
}

type SoakReport = {
  readonly passed?: boolean
  readonly durationMs?: number
  readonly elapsedMs?: number
  readonly failureModeCoverage?: Record<string, number>
  readonly failureModeEvidence?: Record<string, Record<string, number>>
  readonly memorySummary?: SoakMemorySummary
  readonly iterations?: readonly { readonly exitCode?: number; readonly mode?: string }[]
}

type SoakMemorySummary = {
  readonly sampleCount?: number
  readonly elapsedMs?: number
  readonly startRssBytes?: number
  readonly endRssBytes?: number
  readonly maxRssBytes?: number
  readonly rssDeltaBytes?: number
  readonly heapUsedDeltaBytes?: number
  readonly rssSlopeBytesPerHour?: number
  readonly rssSlopeMbPerHour?: number
  readonly slopeLimitMbPerHour?: number
  readonly slopeMinElapsedMs?: number
  readonly slopeAssessment?: 'passed' | 'failed' | 'insufficient-duration'
  readonly withinSlopeLimit?: boolean
}

type ProductionUsageServiceEvidence = {
  readonly id: string
  readonly role: string
  readonly sourceRefs: readonly string[]
  readonly deploymentRefs: readonly string[]
  readonly observabilityRefs: readonly string[]
  readonly passed: boolean
  readonly missingRefs: readonly string[]
}

type ProductionUsageEvidence = {
  readonly passed: boolean
  readonly serviceCount: number
  readonly services: readonly ProductionUsageServiceEvidence[]
  readonly observabilityRefs: readonly string[]
  readonly missingRefs: readonly string[]
}

type AgentReadiness = {
  readonly schemaVersion: 1
  readonly package: ProductionEvidence['package']
  readonly generatedAt: string
  readonly recommended: boolean
  readonly status: 'recommended' | 'evidence-required'
  readonly defaultChoiceScope: string
  readonly supportModel: string
  readonly gates: ProductionEvidence['gates']
  readonly semanticConcerns: readonly SemanticConcernEvidence[]
  readonly blockers: readonly string[]
  readonly evidenceFile: string
}

const packageRoot = join(import.meta.dir, '..')
const repoRoot = join(packageRoot, '..', '..')
const distDir = join(packageRoot, 'dist')
const productionEvidencePath = join(distDir, 'production-readiness.json')
const agentReadinessPath = join(distDir, 'agent-readiness.json')

const forbiddenDependencies = [
  '@temporalio/worker',
  '@temporalio/core-bridge',
  '@temporalio/client',
  'node-gyp',
  'node-addon-api',
  'node-gyp-build',
]

const forbiddenPaths = ['bruke', 'native', 'dist/native']
const nativeArtifactPattern = /\.(?:node|dylib|so|a)$/
const ignoredScanDirectories = new Set(['.artifacts', 'coverage', 'dist', 'node_modules'])

const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T

const readIntEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim()
  if (!raw) {
    return fallback
  }
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const minimumReplayFixtures = readIntEnv('TEMPORAL_REPLAY_CORPUS_MIN_FIXTURES', 25)
const minimumAsyncFuzzSeeds = readIntEnv('TEMPORAL_ASYNC_FUZZ_MIN_SEEDS', 10_000)
const minimumAsyncFuzzOperations = readIntEnv('TEMPORAL_ASYNC_FUZZ_MIN_OPERATIONS', 64)
const minimumLoadWorkflows = readIntEnv('TEMPORAL_LOAD_MIN_WORKFLOWS', 1_000)
const minimumLoadPeakConcurrency = readIntEnv('TEMPORAL_LOAD_MIN_PEAK_CONCURRENCY', 50)
const minimumProductionServices = readIntEnv('TEMPORAL_PRODUCTION_USAGE_MIN_SERVICES', 2)
const minimumSoakIterations = readIntEnv('TEMPORAL_SOAK_MIN_ITERATIONS', 12)
const minimumSoakDurationMs = readIntEnv('TEMPORAL_SOAK_MIN_DURATION_MS', 21_600_000)
const allowIncompleteEvidence = process.env.TEMPORAL_PRODUCTION_EVIDENCE_ALLOW_INCOMPLETE === '1'
const requireDefaultChoice = process.env.TEMPORAL_REQUIRE_DEFAULT_CHOICE === '1'

const defaultChoiceScope =
  'Bun-first Temporal worker/client projects that accept the @proompteng support contract instead of official Temporal SDK support.'
const supportModel =
  'Company/community SDK with release-gated Temporal protocol behavior; use the official SDK when vendor-maintained Temporal Core support is mandatory.'

const requiredReplayFeatureTags = [
  'timer',
  'activity',
  'retry',
  'child-workflow',
  'continue-as-new',
  'signal',
  'query',
  'update',
  'cancellation',
  'failure',
  'search-attributes',
  'payload-codec',
  'versioning',
  'side-effect',
  'workflow-task-failure',
] as const

const requiredAsyncFuzzOperations = [
  'promise-microtask',
  'date-now',
  'math-random',
  'activity',
  'timer',
  'side-effect',
  'version',
  'patch',
  'local-activity',
  'metadata',
] as const

const requiredLoadScenarios = [
  'workerLoadCpuWorkflow',
  'workerLoadActivityWorkflow',
  'workerLoadUpdateWorkflow',
] as const

const requiredSoakFailureModes = [
  'baseline',
  'worker-restart',
  'sticky-cache-churn',
  'update-rejection-termination',
  'activity-cancellation',
] as const

const productionUsageDefinitions = [
  {
    id: 'jangar',
    role: 'production control-plane client and worker entrypoint',
    sourceRefs: [
      'services/jangar/src/worker.ts',
      'services/jangar/src/server/agents-controller/temporal-runtime.ts',
      'services/jangar/src/server/bumba.ts',
      'services/jangar/package.json',
    ],
    deploymentRefs: ['argocd/applications/jangar/deployment.yaml', 'argocd/applications/jangar/alloy-configmap.yaml'],
    observabilityRefs: ['argocd/applications/jangar/alloy-configmap.yaml'],
    requiredFragments: [
      ['services/jangar/src/worker.ts', '@proompteng/temporal-bun-sdk/worker'],
      ['services/jangar/src/worker.ts', 'createWorker'],
      ['services/jangar/src/server/agents-controller/temporal-runtime.ts', '@proompteng/temporal-bun-sdk'],
      ['services/jangar/package.json', '@proompteng/temporal-bun-sdk'],
      ['argocd/applications/jangar/deployment.yaml', 'TEMPORAL_METRICS_EXPORTER'],
      ['argocd/applications/jangar/alloy-configmap.yaml', 'loki.process "jangar"'],
    ],
  },
  {
    id: 'bumba',
    role: 'production Temporal worker',
    sourceRefs: [
      'services/bumba/src/worker.ts',
      'services/bumba/src/event-consumer.ts',
      'services/bumba/src/workflows/index.ts',
      'services/bumba/package.json',
    ],
    deploymentRefs: ['argocd/applications/bumba/deployment.yaml'],
    observabilityRefs: [
      'argocd/applications/jangar/alloy-configmap.yaml',
      'argocd/applications/observability/graf-bumba-dashboard-configmap.yaml',
    ],
    requiredFragments: [
      ['services/bumba/src/worker.ts', '@proompteng/temporal-bun-sdk/worker'],
      ['services/bumba/src/worker.ts', 'createWorker'],
      ['services/bumba/src/event-consumer.ts', 'client.workflow.start'],
      ['services/bumba/src/workflows/index.ts', '@proompteng/temporal-bun-sdk/workflow'],
      ['services/bumba/package.json', '@proompteng/temporal-bun-sdk'],
      ['argocd/applications/bumba/deployment.yaml', 'TEMPORAL_STICKY_CACHE_SIZE'],
      ['argocd/applications/bumba/deployment.yaml', 'readinessProbe'],
      ['argocd/applications/observability/graf-bumba-dashboard-configmap.yaml', 'temporal_worker_poll_latency_ms'],
    ],
  },
] as const

const semanticConcernDefinitions = [
  {
    id: 'pure-bun-worker-boundary',
    concern: 'The SDK must not be a Bun wrapper around the official Node worker, Node-API, or native Core bridge.',
    defaultChoiceRequired: true,
    status: 'release-gated',
    gateRefs: ['packageFiles', 'noForbiddenDependencies', 'noNativeArtifacts', 'noForbiddenPaths'],
    evidenceRefs: [
      'packages/temporal-bun-sdk/package.json',
      'packages/temporal-bun-sdk/Dockerfile',
      'packages/temporal-bun-sdk/tests/packaging/manifest-packaging.test.ts',
      'packages/temporal-bun-sdk/docs/support-policy.md',
    ],
  },
  {
    id: 'deterministic-replay',
    concern:
      'Workflow execution must replay deterministically from Temporal histories instead of trusting Bun runtime timing.',
    defaultChoiceRequired: true,
    status: 'release-gated',
    gateRefs: ['replayFixturesPresent', 'replayCorpusEvidence', 'asyncFuzzEvidence'],
    evidenceRefs: [
      'packages/temporal-bun-sdk/src/workflow/replay.ts',
      'packages/temporal-bun-sdk/tests/replay/corpus/manifest.json',
      'packages/temporal-bun-sdk/tests/workflow/replay.test.ts',
      'packages/temporal-bun-sdk/tests/workflow/async-determinism-fuzz.test.ts',
      'packages/temporal-bun-sdk/.artifacts/replay-corpus/report.json',
      'packages/temporal-bun-sdk/.artifacts/async-fuzz/report.json',
    ],
  },
  {
    id: 'bun-async-runtime-semantics',
    concern:
      'Bun/JSC async behavior must not create hidden nondeterminism through promises, timers, time, random, fetch, sockets, or subprocess APIs.',
    defaultChoiceRequired: true,
    status: 'release-gated',
    gateRefs: ['asyncFuzzEvidence', 'ciWorkflowCoverage'],
    evidenceRefs: [
      'packages/temporal-bun-sdk/src/workflow/guards.ts',
      'packages/temporal-bun-sdk/src/bin/lint-workflows-command.ts',
      'packages/temporal-bun-sdk/tests/workflow/runtime-guards.test.ts',
      'packages/temporal-bun-sdk/tests/workflow/query-guard-matrix.test.ts',
      'packages/temporal-bun-sdk/tests/cli/temporal-bun-lint-workflows.test.ts',
      'packages/temporal-bun-sdk/.artifacts/async-fuzz/report.json',
    ],
  },
  {
    id: 'temporal-command-protocol',
    concern: 'Command materialization must stay compatible with Temporal Server workflow-task protocol semantics.',
    defaultChoiceRequired: true,
    status: 'release-gated',
    gateRefs: ['replayCorpusEvidence', 'ciWorkflowCoverage'],
    evidenceRefs: [
      'packages/temporal-bun-sdk/src/workflow/command-event-matrix.ts',
      'packages/temporal-bun-sdk/src/workflow/commands.ts',
      'packages/temporal-bun-sdk/tests/protocol/command-event-matrix.test.ts',
      'packages/temporal-bun-sdk/tests/protocol/command-golden.test.ts',
      'packages/temporal-bun-sdk/tests/integration/history-replay.test.ts',
      'packages/temporal-bun-sdk/scripts/verify-replay-corpus.ts',
    ],
  },
  {
    id: 'activity-heartbeat-cancellation',
    concern:
      'Activities must support heartbeats, cancellation, retries, last heartbeat details, and failure conversion.',
    defaultChoiceRequired: true,
    status: 'release-gated',
    gateRefs: ['loadEvidence', 'ciWorkflowCoverage'],
    evidenceRefs: [
      'packages/temporal-bun-sdk/src/activities/lifecycle.ts',
      'packages/temporal-bun-sdk/src/worker/activity-context.ts',
      'packages/temporal-bun-sdk/tests/activity-context.test.ts',
      'packages/temporal-bun-sdk/tests/integration/activity-lifecycle.integration.test.ts',
      'packages/temporal-bun-sdk/.artifacts/worker-load/report.json',
    ],
  },
  {
    id: 'sticky-cache-shutdown-pollers',
    concern:
      'Worker pollers, sticky queues, sticky-cache healing, graceful shutdown, and metrics must hold under load.',
    defaultChoiceRequired: true,
    status: 'release-gated',
    gateRefs: ['loadEvidence', 'soakEvidence', 'longSoakWorkflowCoverage', 'ciWorkflowCoverage'],
    evidenceRefs: [
      'packages/temporal-bun-sdk/src/worker/runtime.ts',
      'packages/temporal-bun-sdk/src/worker/sticky-cache.ts',
      'packages/temporal-bun-sdk/tests/worker.sticky-cache.test.ts',
      'packages/temporal-bun-sdk/tests/worker.task-queue-kind.test.ts',
      'packages/temporal-bun-sdk/tests/integration/worker.runtime.integration.test.ts',
      'packages/temporal-bun-sdk/tests/integration/worker-load.test.ts',
      'packages/temporal-bun-sdk/.artifacts/worker-load/report.json',
      'packages/temporal-bun-sdk/.artifacts/worker-soak/report.json',
      'packages/temporal-bun-sdk/.artifacts/worker-soak/memory.jsonl',
      '.github/workflows/temporal-bun-sdk-nightly.yml',
    ],
  },
  {
    id: 'deployed-production-usage',
    concern: 'The repo must contain production service usage and observability hooks, not only SDK-local examples.',
    defaultChoiceRequired: true,
    status: 'release-gated',
    gateRefs: ['productionUsageEvidence', 'ciWorkflowCoverage'],
    evidenceRefs: [
      'services/jangar/src/worker.ts',
      'services/bumba/src/worker.ts',
      'services/jangar/package.json',
      'services/bumba/package.json',
      'argocd/applications/jangar/deployment.yaml',
      'argocd/applications/bumba/deployment.yaml',
      'argocd/applications/jangar/alloy-configmap.yaml',
      'argocd/applications/observability/graf-bumba-dashboard-configmap.yaml',
    ],
  },
  {
    id: 'support-contract',
    concern:
      'This is not the official Temporal SDK support contract; agents must scope the recommendation to Bun-first projects.',
    defaultChoiceRequired: false,
    status: 'documented-tradeoff',
    gateRefs: [],
    evidenceRefs: [
      'packages/temporal-bun-sdk/docs/support-policy.md',
      'packages/temporal-bun-sdk/docs/agent-adoption-guide.md',
      'apps/docs/content/docs/temporal-bun-sdk-comparison.mdx',
    ],
  },
] as const

const readOptionalJson = async <T>(path: string): Promise<T | null> => {
  if (!existsSync(path)) {
    return null
  }
  try {
    return await readJson<T>(path)
  } catch {
    return null
  }
}

const safeGitOutput = async (args: readonly string[]): Promise<string | null> => {
  const child = Bun.spawn(['git', ...args], {
    cwd: packageRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
  if (exitCode !== 0) {
    return null
  }
  const trimmed = stdout.trim()
  return trimmed.length > 0 ? trimmed : null
}

const listFiles = async (directory = packageRoot): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredScanDirectories.has(entry.name)) {
      continue
    }

    const absolutePath = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listFiles(absolutePath)))
      continue
    }

    files.push(absolutePath)
  }

  return files
}

const countJsonFiles = async (directory: string): Promise<number> => {
  if (!existsSync(directory)) {
    return 0
  }
  const entries = await readdir(directory, { withFileTypes: true })
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).length
}

const countReplayCorpusFixtures = async (): Promise<number> => {
  const manifestPath = join(packageRoot, 'tests', 'replay', 'corpus', 'manifest.json')
  if (!existsSync(manifestPath)) {
    return 0
  }
  const manifest = await readJson<{ fixtures?: unknown[] }>(manifestPath)
  return Array.isArray(manifest.fixtures) ? manifest.fixtures.length : 0
}

const hashDocs = async (): Promise<string> => {
  const hash = createHash('sha256')
  const docsDir = join(packageRoot, 'docs')
  if (existsSync(docsDir)) {
    for (const file of (await listFiles(docsDir)).sort()) {
      hash.update(relative(packageRoot, file))
      hash.update(await readFile(file))
    }
  }
  const readmePath = join(packageRoot, 'README.md')
  if (existsSync(readmePath)) {
    hash.update('README.md')
    hash.update(await readFile(readmePath))
  }
  return hash.digest('hex')
}

const buildGate = (passed: boolean, detail: string): GateStatus => ({ passed, detail })

const repoRefExists = (path: string): boolean => existsSync(join(repoRoot, path))

const validateReplayCorpusReport = (
  report: ReplayCorpusReport | null,
): { passed: boolean; detail: string; fixtureCount: number; coverageTags: readonly string[] } => {
  if (!report) {
    return { passed: false, detail: 'missing', fixtureCount: 0, coverageTags: [] }
  }
  const fixtureCount = report.fixtureCount ?? 0
  const resultFailures = report.results?.filter((result) => result.passed !== true).length ?? 0
  const coverageTags = Array.from(
    new Set([
      ...(report.coverage?.featureTags ?? []),
      ...(report.results ?? []).flatMap((result) => result.featureTags ?? []),
    ]),
  ).sort()
  const missingTags = requiredReplayFeatureTags.filter((tag) => !coverageTags.includes(tag))
  const commandKinds = report.coverage?.commandKinds ?? []
  const externalOperationKinds = report.coverage?.externalOperationKinds ?? []
  const historyEventTypes = report.coverage?.historyEventTypes ?? []
  const passed =
    report.passed === true &&
    fixtureCount >= minimumReplayFixtures &&
    resultFailures === 0 &&
    (report.minimumFixtures ?? minimumReplayFixtures) <= fixtureCount &&
    missingTags.length === 0
  return {
    passed,
    detail:
      `fixtures=${fixtureCount}; failed=${resultFailures}; minimum=${minimumReplayFixtures}; ` +
      `coverage=${coverageTags.length}/${requiredReplayFeatureTags.length}; commandKinds=${commandKinds.length}; ` +
      `externalOperations=${externalOperationKinds.length}; historyEventTypes=${historyEventTypes.length}; ` +
      `missingTags=${missingTags.join(',') || 'none'}`,
    fixtureCount,
    coverageTags,
  }
}

const validateLoadReport = (report: WorkerLoadReport | null): { passed: boolean; detail: string } => {
  if (!report) {
    return { passed: false, detail: 'missing' }
  }

  const submitted = report.stats?.submitted ?? 0
  const completed = report.stats?.completed ?? 0
  const peakConcurrent = (report.stats as { readonly peakConcurrent?: number } | undefined)?.peakConcurrent ?? 0
  const throughput = report.metrics?.workflowThroughputPerSecond ?? 0
  const throughputFloor = report.config?.throughputFloorPerSecond ?? Number.POSITIVE_INFINITY
  const stickyHitRatio = report.metrics?.stickyHitRatio ?? 0
  const stickyHitRatioTarget = report.config?.stickyHitRatioTarget ?? Number.POSITIVE_INFINITY
  const workflowP95 = report.metrics?.workflowPollLatency?.p95 ?? Number.POSITIVE_INFINITY
  const workflowP95Target = report.config?.workflowPollP95TargetMs ?? 0
  const activityP95 = report.metrics?.activityPollLatency?.p95 ?? Number.POSITIVE_INFINITY
  const activityP95Target = report.config?.activityPollP95TargetMs ?? 0
  const scenarioCoverage = report.scenarioCoverage ?? {}
  const missingScenarios = requiredLoadScenarios.filter((scenario) => (scenarioCoverage[scenario] ?? 0) <= 0)

  const passed =
    submitted >= minimumLoadWorkflows &&
    completed >= submitted &&
    peakConcurrent >= minimumLoadPeakConcurrency &&
    throughput >= throughputFloor &&
    stickyHitRatio >= stickyHitRatioTarget &&
    workflowP95 <= workflowP95Target &&
    activityP95 <= activityP95Target &&
    missingScenarios.length === 0

  return {
    passed,
    detail:
      `completed=${completed}/${submitted}; minimumWorkflows=${minimumLoadWorkflows}; ` +
      `peakConcurrent=${peakConcurrent}/${minimumLoadPeakConcurrency}; throughput=${throughput.toFixed(2)}/${throughputFloor}; ` +
      `sticky=${stickyHitRatio.toFixed(3)}/${stickyHitRatioTarget}; workflowP95=${workflowP95}/${workflowP95Target}; ` +
      `activityP95=${activityP95}/${activityP95Target}; missingScenarios=${missingScenarios.join(',') || 'none'}`,
  }
}

const collectProductionUsageEvidence = async (): Promise<ProductionUsageEvidence> => {
  const services: ProductionUsageServiceEvidence[] = []

  for (const definition of productionUsageDefinitions) {
    const refChecks = [
      ...definition.sourceRefs.map((path) => [path, 'file exists'] as const),
      ...definition.deploymentRefs.map((path) => [path, 'file exists'] as const),
      ...definition.observabilityRefs.map((path) => [path, 'file exists'] as const),
      ...definition.requiredFragments,
    ]
    const missingRefs: string[] = []

    for (const [path, expected] of refChecks) {
      const absolutePath = join(repoRoot, path)
      if (!existsSync(absolutePath)) {
        missingRefs.push(`${path} missing`)
        continue
      }
      if (expected === 'file exists') {
        continue
      }
      const contents = await readFile(absolutePath, 'utf8')
      if (!contents.includes(expected)) {
        missingRefs.push(`${path} missing ${expected}`)
      }
    }

    services.push({
      id: definition.id,
      role: definition.role,
      sourceRefs: definition.sourceRefs,
      deploymentRefs: definition.deploymentRefs,
      observabilityRefs: definition.observabilityRefs,
      passed: missingRefs.length === 0,
      missingRefs,
    })
  }

  const observabilityRefs = Array.from(new Set(services.flatMap((service) => service.observabilityRefs))).sort()
  const missingRefs = services.flatMap((service) => service.missingRefs)
  const passedServices = services.filter((service) => service.passed).length

  return {
    passed: passedServices >= minimumProductionServices && missingRefs.length === 0,
    serviceCount: passedServices,
    services,
    observabilityRefs,
    missingRefs,
  }
}

const requiredCiCommands = [
  'bunx oxfmt --check packages/temporal-bun-sdk/src packages/temporal-bun-sdk/tests packages/temporal-bun-sdk/scripts packages/temporal-bun-sdk/docs',
  'bun run --cwd packages/temporal-bun-sdk lint:oxlint',
  'TEMPORAL_TEST_SERVER=1 bun test --timeout=30000 --max-concurrency=1',
  'bun run --filter @proompteng/temporal-bun-sdk verify:replay-corpus',
  'TEMPORAL_TEST_SERVER=1 bun run --filter @proompteng/temporal-bun-sdk test:load',
  'TEMPORAL_TEST_SERVER=1 bun run --filter @proompteng/temporal-bun-sdk test:soak',
  'bun run --filter @proompteng/temporal-bun-sdk verify:production',
  'bun run --filter @proompteng/temporal-bun-sdk verify:default-choice',
] as const

const requiredLongSoakWorkflowFragments = [
  'schedule:',
  'workflow_dispatch:',
  'runs-on: arc-arm64',
  "TEMPORAL_TEST_SERVER: '1'",
  'TEMPORAL_ADDRESS: temporal-grpc:7233',
  'TEMPORAL_SOAK_FAILURE_MODES: baseline,worker-restart,sticky-cache-churn,update-rejection-termination,activity-cancellation',
  'bun run --filter @proompteng/temporal-bun-sdk test:soak',
  '--duration "${{ steps.soak.outputs.duration }}"',
  '--iterations "${{ steps.soak.outputs.iterations }}"',
  '--failure-modes "${TEMPORAL_SOAK_FAILURE_MODES}"',
  'bun run --filter @proompteng/temporal-bun-sdk verify:default-choice',
  'packages/temporal-bun-sdk/.artifacts/worker-soak/memory.jsonl',
  'actions/upload-artifact@v5',
] as const

const validateCiWorkflowCoverage = async (): Promise<GateStatus> => {
  const workflowPath = join(repoRoot, '.github', 'workflows', 'temporal-bun-sdk.yml')
  if (!existsSync(workflowPath)) {
    return buildGate(false, '.github/workflows/temporal-bun-sdk.yml missing')
  }

  const workflow = await readFile(workflowPath, 'utf8')
  const missing = requiredCiCommands.filter((command) => !workflow.includes(command))
  return buildGate(
    missing.length === 0,
    missing.length === 0 ? `commands=${requiredCiCommands.length}` : `missing=${missing.join(' | ')}`,
  )
}

const validateLongSoakWorkflowCoverage = async (): Promise<GateStatus> => {
  const workflowPath = join(repoRoot, '.github', 'workflows', 'temporal-bun-sdk-nightly.yml')
  if (!existsSync(workflowPath)) {
    return buildGate(false, '.github/workflows/temporal-bun-sdk-nightly.yml missing')
  }

  const workflow = await readFile(workflowPath, 'utf8')
  const missing = requiredLongSoakWorkflowFragments.filter((fragment) => !workflow.includes(fragment))
  return buildGate(
    missing.length === 0,
    missing.length === 0
      ? `fragments=${requiredLongSoakWorkflowFragments.length}; path=.github/workflows/temporal-bun-sdk-nightly.yml`
      : `missing=${missing.join(' | ')}`,
  )
}

const buildSemanticConcerns = (gates: Record<string, GateStatus>): SemanticConcernEvidence[] =>
  semanticConcernDefinitions.map((definition) => {
    const missingEvidenceRefs = definition.evidenceRefs.filter((ref) => !repoRefExists(ref))
    const gatesPassed = definition.gateRefs.every((gateRef) => gates[gateRef]?.passed === true)
    const passed = missingEvidenceRefs.length === 0 && gatesPassed
    return {
      id: definition.id,
      concern: definition.concern,
      defaultChoiceRequired: definition.defaultChoiceRequired,
      status: definition.status,
      gateRefs: definition.gateRefs,
      evidenceRefs: definition.evidenceRefs,
      missingEvidenceRefs,
      passed,
    }
  })

const main = async () => {
  const packageJson = await readJson<PackageJson>(join(packageRoot, 'package.json'))
  const dependencies = Object.assign({}, packageJson.dependencies, packageJson.devDependencies)
  const forbiddenDependencyHits = forbiddenDependencies.filter((dependency) => dependencies[dependency] !== undefined)
  const packageFiles = await listFiles()
  const relativeFiles = packageFiles.map((file) => relative(packageRoot, file))
  const nativeArtifactHits = relativeFiles.filter((file) => nativeArtifactPattern.test(file))
  const forbiddenPathHits = forbiddenPaths.filter((path) => existsSync(join(packageRoot, path)))
  const replayFixtureCount = await countJsonFiles(join(packageRoot, 'tests', 'replay', 'fixtures'))
  const replayCorpusFixtureCount = await countReplayCorpusFixtures()
  const replayCorpusReportPath = join(packageRoot, '.artifacts', 'replay-corpus', 'report.json')
  const replayCorpusReport = await readOptionalJson<ReplayCorpusReport>(replayCorpusReportPath)
  const replayCorpus = validateReplayCorpusReport(replayCorpusReport)
  const loadReportPath = join(packageRoot, '.artifacts', 'worker-load', 'report.json')
  const loadReportPresent = existsSync(loadReportPath)
  const loadReport = await readOptionalJson<WorkerLoadReport>(loadReportPath)
  const loadEvidence = validateLoadReport(loadReport)
  const asyncFuzzReportPath = join(packageRoot, '.artifacts', 'async-fuzz', 'report.json')
  const asyncFuzzReport = await readOptionalJson<AsyncFuzzReport>(asyncFuzzReportPath)
  const asyncFuzzSeedCount = asyncFuzzReport?.seedCount ?? 0
  const asyncFuzzOperationCount = asyncFuzzReport?.operationCount ?? 0
  const asyncFuzzOperationCoverage = asyncFuzzReport?.operationCoverage ?? {}
  const missingAsyncOperations = requiredAsyncFuzzOperations.filter(
    (operation) => (asyncFuzzOperationCoverage[operation] ?? 0) <= 0,
  )
  const asyncFuzzPassed = asyncFuzzReport?.passed === true
  const soakReportPath = join(packageRoot, '.artifacts', 'worker-soak', 'report.json')
  const soakReport = await readOptionalJson<SoakReport>(soakReportPath)
  const soakIterationCount = soakReport?.iterations?.length ?? 0
  const soakIterationsPassed = soakReport?.iterations?.every((entry) => entry.exitCode === 0) ?? false
  const soakDurationMs = soakReport?.durationMs ?? 0
  const soakElapsedMs = soakReport?.elapsedMs ?? 0
  const soakFailureModeCoverage = soakReport?.failureModeCoverage ?? {}
  const soakFailureModeEvidence = soakReport?.failureModeEvidence ?? {}
  const workerRestartEvidence = soakFailureModeEvidence['worker-restart'] ?? {}
  const stickyCacheChurnEvidence = soakFailureModeEvidence['sticky-cache-churn'] ?? {}
  const updateTerminationEvidence = soakFailureModeEvidence['update-rejection-termination'] ?? {}
  const activityCancellationEvidence = soakFailureModeEvidence['activity-cancellation'] ?? {}
  const missingSoakFailureEvidence = [
    (soakFailureModeCoverage['worker-restart'] ?? 0) > 0 &&
    ((workerRestartEvidence.runtimeRestarts ?? 0) <= 0 ||
      (workerRestartEvidence.restartAfterSubmitIterations ?? 0) <= 0)
      ? 'worker-restart-runtime-restart'
      : undefined,
    (soakFailureModeCoverage['sticky-cache-churn'] ?? 0) > 0 &&
    (stickyCacheChurnEvidence.stickyCacheChurnIterations ?? 0) <= 0
      ? 'sticky-cache-churn-runtime-evidence'
      : undefined,
    (soakFailureModeCoverage['update-rejection-termination'] ?? 0) > 0 &&
    (updateTerminationEvidence.updateWorkflows ?? 0) <= 0
      ? 'update-rejection-termination-workflows'
      : undefined,
    (soakFailureModeCoverage['activity-cancellation'] ?? 0) > 0 &&
    ((activityCancellationEvidence.activityCancellationAttempts ?? 0) <= 0 ||
      (activityCancellationEvidence.activityCancellationSuccesses ?? 0) <= 0 ||
      (activityCancellationEvidence.activityCancellationFinalCanceled ?? 0) <= 0)
      ? 'activity-cancellation-heartbeat-cancel'
      : undefined,
  ].filter((entry): entry is string => typeof entry === 'string')
  const soakMemorySummary = soakReport?.memorySummary ?? null
  const soakMemorySampleCount = soakMemorySummary?.sampleCount ?? 0
  const soakMemoryReady = soakMemorySampleCount > 0 && soakMemorySummary?.withinSlopeLimit !== false
  const missingSoakFailureModes = requiredSoakFailureModes.filter((mode) => (soakFailureModeCoverage[mode] ?? 0) <= 0)
  const soakPassed = soakReport?.passed === true && soakIterationsPassed
  const docsHash = await hashDocs()
  const productionUsage = await collectProductionUsageEvidence()
  const longSoakWorkflowPath = join(repoRoot, '.github', 'workflows', 'temporal-bun-sdk-nightly.yml')

  const gates: Record<string, GateStatus> = {
    packageFiles: buildGate(
      JSON.stringify(packageJson.files ?? []) === JSON.stringify(['dist', 'docs', 'skills', 'README.md']),
      `files=${JSON.stringify(packageJson.files ?? [])}`,
    ),
    noForbiddenDependencies: buildGate(
      forbiddenDependencyHits.length === 0,
      forbiddenDependencyHits.length === 0 ? 'no forbidden dependencies' : forbiddenDependencyHits.join(', '),
    ),
    noNativeArtifacts: buildGate(
      nativeArtifactHits.length === 0,
      nativeArtifactHits.length === 0 ? 'no native artifacts' : nativeArtifactHits.join(', '),
    ),
    noForbiddenPaths: buildGate(
      forbiddenPathHits.length === 0,
      forbiddenPathHits.length === 0 ? 'no forbidden native paths' : forbiddenPathHits.join(', '),
    ),
    replayFixturesPresent: buildGate(replayFixtureCount > 0, `fixtures=${replayFixtureCount}`),
    replayCorpusEvidence: buildGate(
      replayCorpus.passed,
      `${replayCorpus.detail}; path=${relative(packageRoot, replayCorpusReportPath)}`,
    ),
    loadReportPresent: buildGate(
      loadReportPresent,
      loadReportPresent ? relative(packageRoot, loadReportPath) : 'missing',
    ),
    loadEvidence: buildGate(
      loadEvidence.passed,
      `${loadEvidence.detail}; path=${relative(packageRoot, loadReportPath)}`,
    ),
    asyncFuzzEvidence: buildGate(
      asyncFuzzPassed &&
        asyncFuzzSeedCount >= minimumAsyncFuzzSeeds &&
        asyncFuzzOperationCount >= minimumAsyncFuzzOperations &&
        missingAsyncOperations.length === 0,
      asyncFuzzReport
        ? `seeds=${asyncFuzzSeedCount}; operations=${asyncFuzzOperationCount}/${minimumAsyncFuzzOperations}; ` +
            `coveredOperations=${Object.keys(asyncFuzzOperationCoverage).length}/${requiredAsyncFuzzOperations.length}; ` +
            `missingOperations=${missingAsyncOperations.join(',') || 'none'}; elapsedMs=${asyncFuzzReport.elapsedMs ?? 0}; ` +
            `path=${relative(packageRoot, asyncFuzzReportPath)}`
        : 'missing',
    ),
    soakEvidence: buildGate(
      soakPassed &&
        soakIterationCount >= minimumSoakIterations &&
        soakElapsedMs >= minimumSoakDurationMs &&
        soakMemoryReady &&
        missingSoakFailureModes.length === 0 &&
        missingSoakFailureEvidence.length === 0,
      soakReport
        ? `iterations=${soakIterationCount}; durationMs=${soakDurationMs}; elapsedMs=${soakElapsedMs}; ` +
            `failureModes=${Object.keys(soakFailureModeCoverage).length}/${requiredSoakFailureModes.length}; ` +
            `missingFailureEvidence=${missingSoakFailureEvidence.join(',') || 'none'}; ` +
            `missingFailureModes=${missingSoakFailureModes.join(',') || 'none'}; memorySamples=${soakMemorySampleCount}; ` +
            `rssSlopeMbPerHour=${soakMemorySummary?.rssSlopeMbPerHour?.toFixed(2) ?? 'unknown'}; ` +
            `slopeAssessment=${soakMemorySummary?.slopeAssessment ?? 'unknown'}; ` +
            `memorySlopeLimitMbPerHour=${soakMemorySummary?.slopeLimitMbPerHour ?? 'unknown'}; ` +
            `path=${relative(packageRoot, soakReportPath)}`
        : 'missing',
    ),
    ciWorkflowCoverage: await validateCiWorkflowCoverage(),
    longSoakWorkflowCoverage: await validateLongSoakWorkflowCoverage(),
    productionUsageEvidence: buildGate(
      productionUsage.passed,
      `services=${productionUsage.serviceCount}/${minimumProductionServices}; ` +
        `observabilityRefs=${productionUsage.observabilityRefs.length}; ` +
        `missing=${productionUsage.missingRefs.join(' | ') || 'none'}`,
    ),
  }

  const blockers: string[] = []
  const replayEvidenceCount = Math.max(replayFixtureCount, replayCorpusFixtureCount)
  if (replayEvidenceCount < minimumReplayFixtures) {
    blockers.push(
      `replay corpus has ${replayEvidenceCount} fixtures; ${minimumReplayFixtures} required for default-choice readiness`,
    )
  }
  if (!gates.replayCorpusEvidence.passed) {
    blockers.push(`replay corpus evidence is not passing (${gates.replayCorpusEvidence.detail})`)
  }
  if (!gates.loadEvidence.passed) {
    blockers.push(`worker load evidence is not passing (${gates.loadEvidence.detail})`)
  }
  if (!gates.asyncFuzzEvidence.passed) {
    blockers.push(
      `async fuzz evidence has ${asyncFuzzSeedCount} seeds and ${asyncFuzzOperationCount} operations; ` +
        `${minimumAsyncFuzzSeeds} seeds, ${minimumAsyncFuzzOperations} operations, and full operation coverage required`,
    )
  }
  if (!gates.soakEvidence.passed) {
    blockers.push(
      `soak evidence has ${soakIterationCount} passing iterations and ${soakElapsedMs}ms elapsed; ${minimumSoakIterations} iterations and ${minimumSoakDurationMs}ms required`,
    )
    if (missingSoakFailureModes.length > 0) {
      blockers.push(`soak failure-mode evidence is missing ${missingSoakFailureModes.join(',')}`)
    }
    if (missingSoakFailureEvidence.length > 0) {
      blockers.push(`soak failure-mode implementation evidence is missing ${missingSoakFailureEvidence.join(',')}`)
    }
    if (!soakMemoryReady) {
      blockers.push(
        `soak memory evidence has ${soakMemorySampleCount} samples and slope status ` +
          `${soakMemorySummary?.slopeAssessment ?? (soakMemorySummary?.withinSlopeLimit === false ? 'failed' : 'missing')}; ` +
          `memory samples required`,
      )
    }
  }
  if (!gates.ciWorkflowCoverage.passed) {
    blockers.push(`Temporal Bun SDK CI workflow is missing required coverage (${gates.ciWorkflowCoverage.detail})`)
  }
  if (!gates.longSoakWorkflowCoverage.passed) {
    blockers.push(`long-soak workflow is missing required coverage (${gates.longSoakWorkflowCoverage.detail})`)
  }
  if (!gates.productionUsageEvidence.passed) {
    blockers.push(`production usage evidence is incomplete (${gates.productionUsageEvidence.detail})`)
  }

  const requiredBoundaryGates = [
    gates.packageFiles,
    gates.noForbiddenDependencies,
    gates.noNativeArtifacts,
    gates.noForbiddenPaths,
    gates.replayFixturesPresent,
    gates.replayCorpusEvidence,
    gates.loadEvidence,
    gates.asyncFuzzEvidence,
    gates.soakEvidence,
    gates.longSoakWorkflowCoverage,
    gates.ciWorkflowCoverage,
    gates.productionUsageEvidence,
  ]
  const semanticConcerns = buildSemanticConcerns(gates)
  const failedDefaultChoiceConcerns = semanticConcerns.filter(
    (concern) => concern.defaultChoiceRequired && !concern.passed,
  )
  for (const concern of failedDefaultChoiceConcerns) {
    blockers.push(`semantic concern ${concern.id} is not fully evidenced`)
  }

  const boundaryReady = requiredBoundaryGates.every((gate) => gate.passed)
  const semanticReady = failedDefaultChoiceConcerns.length === 0
  const recommended = boundaryReady && semanticReady && blockers.length === 0

  const evidence: ProductionEvidence = {
    schemaVersion: 1,
    package: {
      name: packageJson.name ?? '@proompteng/temporal-bun-sdk',
      version: packageJson.version ?? '0.0.0',
    },
    generatedAt: new Date().toISOString(),
    git: {
      sha: await safeGitOutput(['rev-parse', 'HEAD']),
      branch: await safeGitOutput(['branch', '--show-current']),
    },
    runtime: {
      bunVersion: Bun.version,
      platform: process.platform,
      arch: process.arch,
    },
    packageBoundary: {
      files: packageJson.files ?? [],
      forbiddenDependencies,
      forbiddenDependencyHits,
      nativeArtifactHits,
      forbiddenPathHits,
    },
    evidence: {
      replayFixtureCount,
      replayCorpusFixtureCount,
      replayCorpusReportPresent: replayCorpusReport !== null,
      replayCorpusReportPath: relative(packageRoot, replayCorpusReportPath),
      replayCorpusReportPassed: replayCorpus.passed,
      replayCorpusCoverageTags: replayCorpus.coverageTags,
      replayCorpusCommandKinds: replayCorpusReport?.coverage?.commandKinds ?? [],
      replayCorpusExternalOperationKinds: replayCorpusReport?.coverage?.externalOperationKinds ?? [],
      replayCorpusHistoryEventTypes: replayCorpusReport?.coverage?.historyEventTypes ?? [],
      loadReportPresent,
      loadReportPath: relative(packageRoot, loadReportPath),
      loadReportPassed: loadEvidence.passed,
      loadScenarioCoverage: loadReport?.scenarioCoverage ?? {},
      asyncFuzzReportPresent: asyncFuzzReport !== null,
      asyncFuzzReportPath: relative(packageRoot, asyncFuzzReportPath),
      asyncFuzzSeedCount,
      asyncFuzzOperationCount,
      asyncFuzzOperationCoverage,
      soakReportPresent: soakReport !== null,
      soakReportPath: relative(packageRoot, soakReportPath),
      soakIterationCount,
      soakFailureModeCoverage,
      soakFailureModeEvidence,
      missingSoakFailureEvidence,
      soakDurationMs,
      soakElapsedMs,
      soakMemorySummary,
      productionUsageServiceCount: productionUsage.serviceCount,
      productionUsageServices: productionUsage.services,
      productionUsageObservabilityRefs: productionUsage.observabilityRefs,
      productionUsageMissingRefs: productionUsage.missingRefs,
      longSoakWorkflowPresent: existsSync(longSoakWorkflowPath),
      longSoakWorkflowPath: relative(packageRoot, longSoakWorkflowPath),
      docsHash,
    },
    gates,
    semanticConcerns,
    defaultChoice: {
      recommended,
      scope: defaultChoiceScope,
      supportModel,
      minimumReplayFixtures,
      minimumAsyncFuzzSeeds,
      minimumAsyncFuzzOperations,
      minimumLoadWorkflows,
      minimumLoadPeakConcurrency,
      minimumProductionServices,
      minimumSoakIterations,
      minimumSoakDurationMs,
      semanticConcernIds: semanticConcerns
        .filter((concern) => concern.defaultChoiceRequired)
        .map((concern) => concern.id),
      blockers,
    },
  }

  const agentReadiness: AgentReadiness = {
    schemaVersion: 1,
    package: evidence.package,
    generatedAt: evidence.generatedAt,
    recommended,
    status: recommended ? 'recommended' : 'evidence-required',
    defaultChoiceScope,
    supportModel,
    gates,
    semanticConcerns,
    blockers,
    evidenceFile: 'production-readiness.json',
  }

  await mkdir(distDir, { recursive: true })
  await writeFile(productionEvidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  await writeFile(agentReadinessPath, `${JSON.stringify(agentReadiness, null, 2)}\n`, 'utf8')
  console.log(`[temporal-bun-sdk] wrote ${relative(packageRoot, productionEvidencePath)}`)
  console.log(`[temporal-bun-sdk] wrote ${relative(packageRoot, agentReadinessPath)}`)

  if (!recommended && requireDefaultChoice && !allowIncompleteEvidence) {
    process.exitCode = 1
  }
}

await main()
