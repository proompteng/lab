#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'

import { ensureCli, fatal, repoRoot } from '../shared/cli'

type CliOptions = {
  namespace?: string
  controllerDeployment?: string
  controllerLease?: string
  controllerPort?: number
  minAgeSeconds?: number
  output?: string
  applyBackfill?: boolean
}

type CommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

type AgentRunRecord = Record<string, unknown>

type ControllerProxyEvidence = {
  readyStatus: number | null
  readyBody: string | null
  healthStatus: number | null
  healthBody: string | null
  metricsFetched: boolean
  agentrunWatchMetrics: {
    lines: string[]
    totalEvents: number | null
    hasAgentRunSeries: boolean
  }
  controlPlaneStatus: Record<string, unknown> | null
}

type ControllerEvidence = {
  deploymentName: string
  deploymentImage: string | null
  selector: string | null
  leaderIdentity: string | null
  leaderPodName: string | null
  proxy: ControllerProxyEvidence
}

type AgentRunClassification = 'canonical' | 'duplicate-terminal' | 'untouched' | 'other'

type ClassifiedAgentRun = {
  name: string
  namespace: string
  idempotencyKey: string | null
  phase: string | null
  ageSeconds: number | null
  untouched: boolean
  untouchedReasons: string[]
  classification: AgentRunClassification
  deleteCandidate: boolean
  recreateCandidate: boolean
  canonicalRunName: string | null
  manifest: AgentRunRecord
}

type SnapshotSummary = {
  totalRuns: number
  canonicalCount: number
  duplicateTerminalCount: number
  untouchedCount: number
  deleteCandidateCount: number
  recreateCandidateCount: number
}

type SnapshotReport = {
  capturedAt: string
  namespace: string
  minAgeSeconds: number
  summary: SnapshotSummary
  controller: ControllerEvidence
  runs: ClassifiedAgentRun[]
}

type BackfillAction =
  | {
      action: 'delete'
      name: string
      reason: string
    }
  | {
      action: 'recreate'
      name: string
      reason: string
      manifest: AgentRunRecord
    }

type BackfillResult = {
  deleted: string[]
  recreated: string[]
  skipped: Array<{ name: string; reason: string }>
}

const DEFAULT_NAMESPACE = 'agents'
const DEFAULT_CONTROLLER_DEPLOYMENT = 'agents-controllers'
const DEFAULT_MIN_AGE_SECONDS = 120
const CANONICAL_PHASES = new Set(['Running', 'Succeeded', 'Failed', 'Cancelled'])
const TERMINAL_PHASES = new Set(['Succeeded', 'Failed', 'Cancelled'])
const FINALIZER = 'agents.proompteng.ai/runtime-cleanup'

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const asString = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)
const readNested = (value: unknown, path: Array<string | number>): unknown => {
  let current: unknown = value
  for (const segment of path) {
    if (Array.isArray(current) && typeof segment === 'number') {
      current = current[segment]
      continue
    }
    const record = asRecord(current)
    if (!record) return undefined
    current = record[String(segment)]
  }
  return current
}

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = {}

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bun run packages/scripts/src/jangar/agentrun-ingestion-mitigation.ts [options]

Options:
  --namespace <name>               Namespace to inspect (default: agents)
  --controller-deployment <name>   Controller deployment name (default: agents-controllers)
  --controller-lease <name>        Leader election lease name (default: agents-controllers)
  --controller-port <port>         Controller HTTP port for pod proxy checks (default: 3000)
  --min-age-seconds <seconds>      Minimum age before a run is considered backfill-eligible (default: 120)
  --output <path>                  Write JSON evidence to this path
  --apply-backfill                 Delete untouched duplicates and recreate untouched canonical candidates`)
      process.exit(0)
    }

    if (arg === '--apply-backfill') {
      options.applyBackfill = true
      continue
    }

    if (!arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`)
    }

    const [flag, inlineValue] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined]
    const value = inlineValue ?? argv[index + 1]
    if (inlineValue === undefined) index += 1
    if (value === undefined) {
      throw new Error(`Missing value for ${flag}`)
    }

    switch (flag) {
      case '--namespace':
        options.namespace = value
        break
      case '--controller-deployment':
        options.controllerDeployment = value
        break
      case '--controller-lease':
        options.controllerLease = value
        break
      case '--controller-port':
        options.controllerPort = Number.parseInt(value, 10)
        break
      case '--min-age-seconds':
        options.minAgeSeconds = Number.parseInt(value, 10)
        break
      case '--output':
        options.output = value
        break
      default:
        throw new Error(`Unknown flag: ${flag}`)
    }
  }

  return options
}

const resolveOutputPath = (provided: string | undefined, capturedAt: string) => {
  if (provided) return resolve(repoRoot, provided)
  const stamp = capturedAt.replaceAll(':', '').replaceAll('.', '').replaceAll('-', '')
  return resolve(repoRoot, 'artifacts', 'jangar', 'agentrun-ingestion', `${stamp}.json`)
}

const runCapture = async (command: string, args: string[], allowFailure = false): Promise<CommandResult> => {
  const subprocess = Bun.spawn([command, ...args], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    subprocess.stdout ? new Response(subprocess.stdout).text() : Promise.resolve(''),
    subprocess.stderr ? new Response(subprocess.stderr).text() : Promise.resolve(''),
    subprocess.exited,
  ])

  if (exitCode !== 0 && !allowFailure) {
    throw new Error(`Command failed (${exitCode}): ${command} ${args.join(' ')}\n${stderr || stdout}`.trim())
  }

  return { stdout, stderr, exitCode }
}

const kubectlJson = async <T>(args: string[]): Promise<T> => {
  const result = await runCapture('kubectl', [...args, '-o', 'json'])
  return JSON.parse(result.stdout) as T
}

const kubectlRaw = async (path: string) => {
  const result = await runCapture('kubectl', ['get', '--raw', path], true)
  return result
}

const parseTimestampMs = (value: unknown): number | null => {
  const text = asString(value)
  if (!text) return null
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? null : parsed
}

const resolveAgeSeconds = (manifest: AgentRunRecord, nowMs: number): number | null => {
  const createdAtMs = parseTimestampMs(readNested(manifest, ['metadata', 'creationTimestamp']))
  if (createdAtMs === null) return null
  return Math.max(0, Math.floor((nowMs - createdAtMs) / 1000))
}

const getUntouchedReasons = (manifest: AgentRunRecord): string[] => {
  const metadata = asRecord(manifest.metadata) ?? {}
  const status = asRecord(manifest.status) ?? {}
  const reasons: string[] = []
  const phase = asString(status.phase)
  const generation = metadata.generation
  const observedGeneration = status.observedGeneration
  const finalizers = asArray(metadata.finalizers).filter((entry): entry is string => typeof entry === 'string')

  if (!phase) reasons.push('missing_phase')
  if (observedGeneration == null) {
    reasons.push('missing_observed_generation')
  } else if (generation != null && observedGeneration !== generation) {
    reasons.push('generation_drift')
  }
  if (!finalizers.includes(FINALIZER)) {
    reasons.push('missing_finalizer')
  }

  return reasons
}

const sanitizeForRecreate = (manifest: AgentRunRecord): AgentRunRecord => {
  const metadata = { ...(asRecord(manifest.metadata) ?? {}) }
  delete metadata.uid
  delete metadata.resourceVersion
  delete metadata.managedFields
  delete metadata.creationTimestamp
  delete metadata.generation
  if (Array.isArray(metadata.finalizers)) {
    metadata.finalizers = metadata.finalizers.filter((entry) => entry !== FINALIZER)
    if ((metadata.finalizers as unknown[]).length === 0) {
      delete metadata.finalizers
    }
  }

  const recreated: AgentRunRecord = {
    ...(manifest.apiVersion ? { apiVersion: manifest.apiVersion } : {}),
    ...(manifest.kind ? { kind: manifest.kind } : {}),
    metadata,
  }
  const spec = asRecord(manifest.spec)
  if (spec) recreated.spec = spec
  return recreated
}

const rankCanonicalPhase = (phase: string | null) => {
  if (phase === 'Running') return 0
  if (phase === 'Succeeded') return 1
  if (phase === 'Failed') return 2
  if (phase === 'Cancelled') return 3
  return 99
}

const chooseCanonical = (runs: Array<{ manifest: AgentRunRecord; phase: string | null; ageSeconds: number | null }>) =>
  [...runs].sort((left, right) => {
    const phaseOrder = rankCanonicalPhase(left.phase) - rankCanonicalPhase(right.phase)
    if (phaseOrder !== 0) return phaseOrder
    const ageLeft = left.ageSeconds ?? Number.MAX_SAFE_INTEGER
    const ageRight = right.ageSeconds ?? Number.MAX_SAFE_INTEGER
    if (ageLeft !== ageRight) return ageLeft - ageRight
    const nameLeft = asString(readNested(left.manifest, ['metadata', 'name'])) ?? ''
    const nameRight = asString(readNested(right.manifest, ['metadata', 'name'])) ?? ''
    return nameLeft.localeCompare(nameRight)
  })[0] ?? null

const classifyAgentRuns = (items: AgentRunRecord[], now: Date, minAgeSeconds: number): ClassifiedAgentRun[] => {
  const nowMs = now.getTime()
  const grouped = new Map<
    string,
    Array<{ manifest: AgentRunRecord; phase: string | null; ageSeconds: number | null }>
  >()

  for (const manifest of items) {
    const idempotencyKey = asString(readNested(manifest, ['spec', 'idempotencyKey']))
    if (!idempotencyKey) continue
    const phase = asString(readNested(manifest, ['status', 'phase']))
    const ageSeconds = resolveAgeSeconds(manifest, nowMs)
    const bucket = grouped.get(idempotencyKey) ?? []
    bucket.push({ manifest, phase, ageSeconds })
    grouped.set(idempotencyKey, bucket)
  }

  const canonicalByKey = new Map<string, string>()
  for (const [key, bucket] of grouped.entries()) {
    const canonical = chooseCanonical(
      bucket.filter((entry) => entry.phase !== null && CANONICAL_PHASES.has(entry.phase)),
    )
    if (canonical) {
      const name = asString(readNested(canonical.manifest, ['metadata', 'name']))
      if (name) canonicalByKey.set(key, name)
    }
  }

  return items
    .map((manifest) => {
      const name = asString(readNested(manifest, ['metadata', 'name'])) ?? 'unknown'
      const namespace = asString(readNested(manifest, ['metadata', 'namespace'])) ?? DEFAULT_NAMESPACE
      const idempotencyKey = asString(readNested(manifest, ['spec', 'idempotencyKey']))
      const phase = asString(readNested(manifest, ['status', 'phase']))
      const ageSeconds = resolveAgeSeconds(manifest, nowMs)
      const untouchedReasons = getUntouchedReasons(manifest)
      const untouched = untouchedReasons.length > 0
      const canonicalRunName = idempotencyKey ? (canonicalByKey.get(idempotencyKey) ?? null) : null
      const isOlderThanThreshold = ageSeconds !== null && ageSeconds >= minAgeSeconds
      const isCanonical = canonicalRunName === name
      const classification: AgentRunClassification = untouched
        ? 'untouched'
        : idempotencyKey && canonicalRunName && !isCanonical && phase !== null && TERMINAL_PHASES.has(phase)
          ? 'duplicate-terminal'
          : isCanonical
            ? 'canonical'
            : 'other'

      return {
        name,
        namespace,
        idempotencyKey,
        phase,
        ageSeconds,
        untouched,
        untouchedReasons,
        classification,
        deleteCandidate: untouched && isOlderThanThreshold && Boolean(canonicalRunName && !isCanonical),
        recreateCandidate: untouched && isOlderThanThreshold && !canonicalRunName,
        canonicalRunName,
        manifest,
      } satisfies ClassifiedAgentRun
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

const buildSummary = (runs: ClassifiedAgentRun[]): SnapshotSummary => ({
  totalRuns: runs.length,
  canonicalCount: runs.filter((run) => run.classification === 'canonical').length,
  duplicateTerminalCount: runs.filter((run) => run.classification === 'duplicate-terminal').length,
  untouchedCount: runs.filter((run) => run.classification === 'untouched').length,
  deleteCandidateCount: runs.filter((run) => run.deleteCandidate).length,
  recreateCandidateCount: runs.filter((run) => run.recreateCandidate).length,
})

const buildLabelSelector = (deployment: Record<string, unknown>) => {
  const labels = asRecord(readNested(deployment, ['spec', 'selector', 'matchLabels'])) ?? {}
  const entries = Object.entries(labels).filter(([, value]) => typeof value === 'string' && value.length > 0)
  if (entries.length === 0) return null
  return entries.map(([key, value]) => `${key}=${String(value)}`).join(',')
}

const getPrimaryContainer = (deployment: Record<string, unknown>) =>
  asRecord(readNested(deployment, ['spec', 'template', 'spec', 'containers', 0]))

const resolveDeploymentPort = (deployment: Record<string, unknown>, preferredPort: number | undefined) => {
  if (preferredPort && Number.isFinite(preferredPort)) return preferredPort
  const container = getPrimaryContainer(deployment)
  const declaredPort = readNested(container, ['ports', 0, 'containerPort'])
  if (typeof declaredPort === 'number' && Number.isFinite(declaredPort)) {
    return Math.floor(declaredPort)
  }
  const env = asArray(container?.env)
  const portEnv = env.map((entry) => asRecord(entry)).find((entry) => asString(entry?.name) === 'PORT')
  const portValue = Number.parseInt(asString(portEnv?.value) ?? '', 10)
  return Number.isFinite(portValue) ? portValue : 8080
}

const resolveLeaseNameFromDeployment = (deployment: Record<string, unknown>) => {
  const container = getPrimaryContainer(deployment)
  const env = asArray(container?.env)
  const leaseEnv = env
    .map((entry) => asRecord(entry))
    .find((entry) => asString(entry?.name) === 'JANGAR_LEADER_ELECTION_LEASE_NAME')
  return asString(leaseEnv?.value)
}

const normalizeLeaderPodName = (holderIdentity: string | null) => {
  if (!holderIdentity) return null
  return holderIdentity.split('_')[0] ?? holderIdentity
}

const resolveControllerLease = async (
  namespace: string,
  deployment: Record<string, unknown>,
  preferredLease: string | undefined,
) => {
  if (preferredLease) return preferredLease
  const fromDeployment = resolveLeaseNameFromDeployment(deployment)
  if (fromDeployment) return fromDeployment

  const leases = await kubectlJson<Record<string, unknown>>(['-n', namespace, 'get', 'lease'])
  const items = asArray(leases.items)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
  if (items.length === 1) {
    return asString(readNested(items[0], ['metadata', 'name']))
  }
  throw new Error('unable to resolve controller lease name automatically; pass --controller-lease')
}

const readMetricLines = (metricsText: string) =>
  metricsText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) => line.startsWith('jangar_kube_watch_events_total') && line.includes('agentruns.agents.proompteng.ai'),
    )

const sumMetricValues = (lines: string[]) => {
  let total = 0
  let seen = false
  for (const line of lines) {
    const value = Number.parseFloat(line.split(/\s+/).at(-1) ?? '')
    if (Number.isFinite(value)) {
      total += value
      seen = true
    }
  }
  return seen ? total : null
}

const parseJsonOrNull = (text: string): Record<string, unknown> | null => {
  try {
    return asRecord(JSON.parse(text))
  } catch {
    return null
  }
}

const fetchProxy = async (namespace: string, podName: string, port: number, path: string) => {
  const result = await kubectlRaw(`/api/v1/namespaces/${namespace}/pods/${podName}:${port}/proxy${path}`)
  return {
    status: result.exitCode === 0 ? 200 : null,
    body: result.exitCode === 0 ? result.stdout.trim() : result.stderr.trim() || result.stdout.trim() || null,
  }
}

const collectControllerEvidence = async (
  namespace: string,
  controllerDeployment: string,
  controllerLease: string | undefined,
  controllerPort: number | undefined,
): Promise<ControllerEvidence> => {
  const deployment = await kubectlJson<Record<string, unknown>>([
    '-n',
    namespace,
    'get',
    'deployment',
    controllerDeployment,
  ])
  const deploymentImage =
    asString(readNested(deployment, ['spec', 'template', 'spec', 'containers', 0, 'image'])) ?? null
  const effectivePort = resolveDeploymentPort(deployment, controllerPort)
  const selector = buildLabelSelector(deployment)
  const leaseName = await resolveControllerLease(namespace, deployment, controllerLease)
  const lease = await kubectlJson<Record<string, unknown>>(['-n', namespace, 'get', 'lease', leaseName])
  const leaderIdentity = asString(readNested(lease, ['spec', 'holderIdentity']))

  let leaderPodName: string | null = normalizeLeaderPodName(leaderIdentity)
  if (!leaderPodName && selector) {
    const pods = await kubectlJson<Record<string, unknown>>(['-n', namespace, 'get', 'pods', '-l', selector])
    leaderPodName = asString(readNested(pods, ['items', 0, 'metadata', 'name']))
  }

  const proxy: ControllerProxyEvidence = {
    readyStatus: null,
    readyBody: null,
    healthStatus: null,
    healthBody: null,
    metricsFetched: false,
    agentrunWatchMetrics: {
      lines: [],
      totalEvents: null,
      hasAgentRunSeries: false,
    },
    controlPlaneStatus: null,
  }

  if (leaderPodName) {
    const ready = await fetchProxy(namespace, leaderPodName, effectivePort, '/ready')
    proxy.readyStatus = ready.status
    proxy.readyBody = ready.body

    const health = await fetchProxy(namespace, leaderPodName, effectivePort, '/health')
    proxy.healthStatus = health.status
    proxy.healthBody = health.body

    const metrics = await fetchProxy(namespace, leaderPodName, effectivePort, '/metrics')
    if (metrics.status === 200 && metrics.body) {
      const metricLines = readMetricLines(metrics.body)
      proxy.metricsFetched = true
      proxy.agentrunWatchMetrics = {
        lines: metricLines,
        totalEvents: sumMetricValues(metricLines),
        hasAgentRunSeries: metricLines.length > 0,
      }
    }

    const controlPlaneStatus = await fetchProxy(
      namespace,
      leaderPodName,
      effectivePort,
      `/api/agents/control-plane/status?namespace=${encodeURIComponent(namespace)}`,
    )
    proxy.controlPlaneStatus = controlPlaneStatus.body ? parseJsonOrNull(controlPlaneStatus.body) : null
  }

  return {
    deploymentName: controllerDeployment,
    deploymentImage: deploymentImage ?? null,
    selector,
    leaderIdentity,
    leaderPodName,
    proxy,
  }
}

const collectSnapshot = async (
  options: Required<
    Pick<CliOptions, 'namespace' | 'controllerDeployment' | 'controllerLease' | 'controllerPort' | 'minAgeSeconds'>
  >,
) => {
  const capturedAt = new Date().toISOString()
  const agentRunsPayload = await kubectlJson<Record<string, unknown>>([
    '-n',
    options.namespace,
    'get',
    'agentruns.agents.proompteng.ai',
  ])
  const items = asArray(agentRunsPayload.items)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is AgentRunRecord => Boolean(entry))
  const runs = classifyAgentRuns(items, new Date(capturedAt), options.minAgeSeconds)
  const controller = await collectControllerEvidence(
    options.namespace,
    options.controllerDeployment,
    options.controllerLease || undefined,
    options.controllerPort || undefined,
  )

  return {
    capturedAt,
    namespace: options.namespace,
    minAgeSeconds: options.minAgeSeconds,
    summary: buildSummary(runs),
    controller,
    runs,
  } satisfies SnapshotReport
}

const writeReport = (report: SnapshotReport, outputPath: string) => {
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, JSON.stringify(report, null, 2))
}

const buildBackfillPlan = (report: SnapshotReport): BackfillAction[] => {
  const ingestionStatus = asString(
    readNested(report.controller.proxy.controlPlaneStatus, ['agentrun_ingestion', 'status']),
  )
  return report.runs.flatMap<BackfillAction>((run) => {
    if (run.deleteCandidate) {
      return [
        {
          action: 'delete',
          name: run.name,
          reason: `untouched duplicate of canonical run ${run.canonicalRunName}`,
        } satisfies BackfillAction,
      ]
    }
    if (run.recreateCandidate) {
      if (ingestionStatus === 'degraded') {
        return []
      }
      return [
        {
          action: 'recreate',
          name: run.name,
          reason: 'untouched run without canonical peer',
          manifest: sanitizeForRecreate(run.manifest),
        } satisfies BackfillAction,
      ]
    }
    return []
  })
}

const applyBackfillPlan = async (namespace: string, actions: BackfillAction[]): Promise<BackfillResult> => {
  const result: BackfillResult = { deleted: [], recreated: [], skipped: [] }

  for (const action of actions) {
    try {
      if (action.action === 'delete') {
        await runCapture('kubectl', ['-n', namespace, 'delete', 'agentrun', action.name, '--ignore-not-found=true'])
        result.deleted.push(action.name)
        continue
      }

      await runCapture('kubectl', [
        '-n',
        namespace,
        'delete',
        'agentrun',
        action.name,
        '--ignore-not-found=true',
        '--wait=true',
      ])
      const subprocess = Bun.spawn(['kubectl', 'apply', '-f', '-'], {
        cwd: repoRoot,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      subprocess.stdin?.write(JSON.stringify(action.manifest))
      subprocess.stdin?.end()
      const [stdout, stderr, exitCode] = await Promise.all([
        subprocess.stdout ? new Response(subprocess.stdout).text() : Promise.resolve(''),
        subprocess.stderr ? new Response(subprocess.stderr).text() : Promise.resolve(''),
        subprocess.exited,
      ])
      if (exitCode !== 0) {
        throw new Error(stderr || stdout || `kubectl apply failed for ${action.name}`)
      }
      result.recreated.push(action.name)
    } catch (error) {
      result.skipped.push({
        name: action.name,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return result
}

const printSummary = (report: SnapshotReport, actions: BackfillAction[]) => {
  console.log(
    JSON.stringify(
      {
        capturedAt: report.capturedAt,
        namespace: report.namespace,
        summary: report.summary,
        controller: {
          deploymentName: report.controller.deploymentName,
          deploymentImage: report.controller.deploymentImage,
          leaderIdentity: report.controller.leaderIdentity,
          leaderPodName: report.controller.leaderPodName,
          readyStatus: report.controller.proxy.readyStatus,
          metricsFetched: report.controller.proxy.metricsFetched,
          agentrunWatchSeriesPresent: report.controller.proxy.agentrunWatchMetrics.hasAgentRunSeries,
          agentrunWatchEventTotal: report.controller.proxy.agentrunWatchMetrics.totalEvents,
          controlPlaneAgentRunIngestion: readNested(report.controller.proxy.controlPlaneStatus, ['agentrun_ingestion']),
        },
        plannedActions: actions.map((action) => ({
          action: action.action,
          name: action.name,
          reason: action.reason,
        })),
      },
      null,
      2,
    ),
  )
}

const main = async () => {
  ensureCli('kubectl')
  const parsed = parseArgs(process.argv.slice(2))
  const options = {
    namespace: parsed.namespace ?? DEFAULT_NAMESPACE,
    controllerDeployment: parsed.controllerDeployment ?? DEFAULT_CONTROLLER_DEPLOYMENT,
    controllerLease: parsed.controllerLease,
    controllerPort: parsed.controllerPort,
    minAgeSeconds: parsed.minAgeSeconds ?? DEFAULT_MIN_AGE_SECONDS,
    output: parsed.output,
    applyBackfill: parsed.applyBackfill ?? false,
  }

  const report = await collectSnapshot(options)
  const outputPath = resolveOutputPath(options.output, report.capturedAt)
  writeReport(report, outputPath)
  const actions = buildBackfillPlan(report)
  printSummary(report, actions)
  console.log(`Evidence written to ${outputPath}`)

  if (!options.applyBackfill) {
    return
  }

  const result = await applyBackfillPlan(options.namespace, actions)
  console.log(JSON.stringify({ namespace: options.namespace, backfill: result }, null, 2))
}

if (import.meta.main) {
  main().catch((error) => fatal('AgentRun ingestion mitigation failed', error))
}

export const __private = {
  parseArgs,
  getUntouchedReasons,
  classifyAgentRuns,
  buildBackfillPlan,
  sanitizeForRecreate,
  normalizeLeaderPodName,
}
