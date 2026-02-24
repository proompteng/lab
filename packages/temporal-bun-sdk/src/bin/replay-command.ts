import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, relative, resolve } from 'node:path'
import { cwd } from 'node:process'
import { create, fromJson, type JsonValue } from '@bufbuild/protobuf'
import { Effect } from 'effect'

import { buildCodecsFromConfig, createDefaultDataConverter } from '../common/payloads'
import type { TemporalConfig } from '../config'
import { WorkflowExecutionSchema } from '../proto/temporal/api/common/v1/message_pb'
import { EventType } from '../proto/temporal/api/enums/v1/event_type_pb'
import { HistoryEventFilterType } from '../proto/temporal/api/enums/v1/workflow_pb'
import { type HistoryEvent, HistorySchema } from '../proto/temporal/api/history/v1/message_pb'
import { GetWorkflowExecutionHistoryRequestSchema } from '../proto/temporal/api/workflowservice/v1/request_response_pb'
import {
  ObservabilityService,
  TemporalConfigService,
  type WorkflowServiceClient,
  WorkflowServiceClientService,
} from '../runtime/effect-layers'
import type { WorkflowInfo } from '../workflow/context'
import type { WorkflowDeterminismFailureMetadata } from '../workflow/determinism'
import {
  type DeterminismDiffResult,
  diffDeterminismState,
  ingestWorkflowHistory,
  resolveHistoryLastEventId,
} from '../workflow/replay'

type ReplayHistorySourceKind = 'file' | 'cli' | 'service'
export type ReplayHistorySourcePreference = 'auto' | 'cli' | 'service'

type BunReadableStream = ReadableStream<Uint8Array<ArrayBufferLike>> | number | null

type Mutable<T> = {
  -readonly [K in keyof T]: T[K]
}

interface WorkflowExecutionRef {
  readonly workflowId: string
  readonly runId: string
}

interface ReplaySingleOptions {
  readonly historyFile?: string
  readonly execution?: WorkflowExecutionRef
  readonly workflowType?: string
  readonly namespaceOverride?: string
  readonly temporalCliPath?: string
  readonly source: ReplayHistorySourcePreference
  readonly jsonOutput: boolean
  readonly debug: boolean
}

interface ReplayDirectoryOptions {
  readonly historyDir: string
  readonly outDir?: string
  readonly workflowType?: string
  readonly namespaceOverride?: string
  readonly temporalCliPath?: string
  readonly source: ReplayHistorySourcePreference
  readonly jsonOutput: boolean
  readonly debug: boolean
}

type ReplayCommandOptions = ReplaySingleOptions | ReplayDirectoryOptions

type ReplayExecutionOptions = ReplaySingleOptions & { execution: WorkflowExecutionRef }

const isReplayOptions = (value: unknown): value is ReplayCommandOptions =>
  Boolean(
    value &&
    typeof value === 'object' &&
    ('historyFile' in (value as Record<string, unknown>) ||
      'historyDir' in (value as Record<string, unknown>) ||
      'execution' in (value as Record<string, unknown>)),
  )

interface HistoryMetadata {
  readonly workflowId?: string
  readonly runId?: string
  readonly workflowType?: string
  readonly namespace?: string
  readonly taskQueue?: string
  readonly temporalVersion?: string
}

interface HistorySourceRecord {
  readonly events: HistoryEvent[]
  readonly source: ReplayHistorySourceKind
  readonly description: string
  readonly metadata: HistoryMetadata
}

interface HistoryLoaderAttempt {
  readonly source: Exclude<ReplayHistorySourceKind, 'file'>
  readonly error: string
}

interface HistoryLoadOutcome {
  readonly record: HistorySourceRecord
  readonly attempts: HistoryLoaderAttempt[]
}

type HistoryLoaders = {
  readonly cli: typeof loadHistoryViaCli
  readonly service: typeof loadHistoryViaService
}

type HistoryPageToken = Uint8Array<ArrayBufferLike>

const defaultHistoryLoaders: HistoryLoaders = {
  cli: loadHistoryViaCli,
  service: loadHistoryViaService,
}

const EVENT_TYPE_LOOKUP = EventType as unknown as Record<string, number>

export interface ReplayRunResult {
  readonly exitCode: number
  readonly summary: ReplaySummary
}

export interface ReplayBatchResult {
  readonly exitCode: number
  readonly summaries: readonly ReplaySummary[]
  readonly historyDir: string
  readonly outDir?: string
  readonly reportPath?: string
  readonly startedAtIso: string
  readonly durationMs: number
  readonly status: 'ok' | 'nondeterministic'
}

export interface ReplaySummary {
  readonly workflow: WorkflowInfo
  readonly history: {
    readonly source: ReplayHistorySourceKind
    readonly description: string
    readonly eventCount: number
    readonly lastEventId: string | null
    readonly metadata: HistoryMetadata
  }
  readonly determinism: {
    readonly hasMarker: boolean
    readonly mismatchCount: number
    readonly mismatches: DeterminismDiffResult['mismatches']
    readonly ignoredMismatchCount?: number
    readonly ignoredMismatches?: DeterminismDiffResult['mismatches']
    readonly failureMetadata?: WorkflowDeterminismFailureMetadata
  }
  readonly attempts: HistoryLoaderAttempt[]
  readonly preference: ReplayHistorySourcePreference
  readonly startedAtIso: string
  readonly durationMs: number
  readonly status: 'ok' | 'nondeterministic'
}

class ReplayCommandError extends Error {
  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ReplayCommandError'
  }
}

const executeReplayInternal = (
  options: ReplaySingleOptions,
): Effect.Effect<
  ReplayRunResult,
  ReplayCommandError,
  TemporalConfigService | ObservabilityService | WorkflowServiceClientService
> =>
  Effect.gen(function* () {
    const startTime = Date.now()
    const config = yield* TemporalConfigService
    const { logger, metricsRegistry, metricsExporter } = yield* ObservabilityService
    const workflowService = yield* WorkflowServiceClientService
    if (options.debug) {
      yield* Effect.sync(() => {
        // biome-ignore lint/suspicious/noDebugger: intentional breakpoint for --debug replay mode
        debugger
      })
    }
    const historyOutcome = yield* Effect.tryPromise({
      try: () => loadReplayHistory(options, config, workflowService),
      catch: (error) =>
        error instanceof ReplayCommandError
          ? error
          : new ReplayCommandError('Failed to load workflow history', { cause: error }),
    })

    const workflowInfo = resolveWorkflowInfo({
      config,
      options,
      metadata: historyOutcome.record.metadata,
    })

    const dataConverter = createDefaultDataConverter({
      payloadCodecs: buildCodecsFromConfig(config.payloadCodecs),
      logger,
      metricsRegistry,
    })

    yield* logger.log('info', 'temporal-bun replay started', {
      workflowId: workflowInfo.workflowId,
      runId: workflowInfo.runId,
      workflowType: workflowInfo.workflowType,
      namespace: workflowInfo.namespace,
      historySource: historyOutcome.record.source,
      historyDescription: historyOutcome.record.description,
    })

    const baselineReplay = yield* Effect.catchAll(
      ingestWorkflowHistory({
        info: workflowInfo,
        history: historyOutcome.record.events,
        dataConverter,
      }),
      (error) =>
        Effect.fail(
          new ReplayCommandError('Failed to ingest workflow history', {
            cause: error,
          }),
        ),
    )
    const actualReplay = baselineReplay.hasDeterminismMarker
      ? yield* Effect.catchAll(
          ingestWorkflowHistory({
            info: workflowInfo,
            history: historyOutcome.record.events,
            dataConverter,
            ignoreDeterminismMarker: true,
          }),
          (error) =>
            Effect.fail(
              new ReplayCommandError('Failed to ingest workflow history', {
                cause: error,
              }),
            ),
        )
      : baselineReplay

    const diffResult = baselineReplay.hasDeterminismMarker
      ? yield* diffDeterminismState(baselineReplay.determinismState, actualReplay.determinismState)
      : undefined

    const allMismatches = diffResult?.mismatches ?? []
    const ignoredMismatches = allMismatches.filter((mismatch) => mismatch.kind === 'random' || mismatch.kind === 'time')
    const mismatches = allMismatches.filter((mismatch) => mismatch.kind !== 'random' && mismatch.kind !== 'time')
    const mismatchCount = mismatches.length
    const exitCode = mismatchCount > 0 ? 2 : 0
    const durationMs = Date.now() - startTime

    const replayCounter = yield* metricsRegistry.counter(
      'temporal_bun_replay_runs_total',
      'Temporal replay CLI command executions',
    )
    yield* replayCounter.inc()
    if (mismatchCount > 0) {
      const mismatchCounter = yield* metricsRegistry.counter(
        'temporal_bun_replay_mismatches_total',
        'Temporal replay CLI determinism mismatches',
      )
      yield* mismatchCounter.inc(mismatchCount)
    }

    const summary: ReplaySummary = {
      workflow: workflowInfo,
      history: {
        source: historyOutcome.record.source,
        description: historyOutcome.record.description,
        eventCount: historyOutcome.record.events.length,
        lastEventId: resolveHistoryLastEventId(historyOutcome.record.events),
        metadata: historyOutcome.record.metadata,
      },
      determinism: {
        hasMarker: baselineReplay.hasDeterminismMarker,
        mismatchCount,
        mismatches,
        ...(ignoredMismatches.length > 0 ? { ignoredMismatchCount: ignoredMismatches.length, ignoredMismatches } : {}),
        failureMetadata: actualReplay.determinismState.failureMetadata,
      },
      attempts: historyOutcome.attempts,
      preference: options.source,
      startedAtIso: new Date(startTime).toISOString(),
      durationMs,
      status: mismatchCount > 0 ? 'nondeterministic' : 'ok',
    }

    const logFields = {
      workflowId: workflowInfo.workflowId,
      runId: workflowInfo.runId,
      workflowType: workflowInfo.workflowType,
      namespace: workflowInfo.namespace,
      eventCount: summary.history.eventCount,
      mismatches: mismatchCount,
      historySource: summary.history.source,
      durationMs,
    }

    if (mismatchCount > 0) {
      yield* logger.log('warn', 'temporal-bun replay detected nondeterminism', logFields)
    } else {
      yield* logger.log('info', 'temporal-bun replay completed without mismatches', logFields)
    }

    yield* metricsExporter.flush()

    return { exitCode, summary }
  })

export const executeReplay = (
  flagsOrOptions: Record<string, string | boolean> | ReplayCommandOptions,
): Effect.Effect<
  ReplayRunResult | ReplayBatchResult,
  ReplayCommandError,
  TemporalConfigService | ObservabilityService | WorkflowServiceClientService
> => {
  const options = isReplayOptions(flagsOrOptions)
    ? flagsOrOptions
    : parseReplayOptions(flagsOrOptions as Record<string, string | boolean>)
  if ('historyDir' in options) {
    return executeReplayDirectoryInternal(options)
  }
  return executeReplayInternal(options)
}

export const parseReplayOptions = (flags: Record<string, string | boolean>): ReplayCommandOptions => {
  const historyFile = readStringFlag(flags['history-file'])
  const historyDir = readStringFlag(flags['history-dir'])
  const outDir = readStringFlag(flags.out)
  const executionFlag = readStringFlag(flags.execution)
  const workflowType = readStringFlag(flags['workflow-type'])
  const namespaceOverride = readStringFlag(flags.namespace)
  const temporalCliPath = readStringFlag(flags['temporal-cli']) ?? process.env.TEMPORAL_CLI_PATH
  const sourceValue = readStringFlag(flags.source)?.toLowerCase() as ReplayHistorySourcePreference | undefined
  const jsonOutput = readBooleanFlag(flags.json)
  const debug = readBooleanFlag(flags.debug)

  if ((historyFile ? 1 : 0) + (historyDir ? 1 : 0) + (executionFlag ? 1 : 0) !== 1) {
    throw new ReplayCommandError(
      'Provide exactly one of --history-file, --history-dir, or --execution <workflowId/runId>',
    )
  }

  let execution: WorkflowExecutionRef | undefined
  if (executionFlag) {
    execution = parseExecutionFlag(executionFlag)
  }

  const source: ReplayHistorySourcePreference =
    sourceValue && ['auto', 'cli', 'service'].includes(sourceValue) ? sourceValue : 'auto'

  if (historyDir) {
    return {
      historyDir: resolve(cwd(), historyDir),
      outDir: outDir ? resolve(cwd(), outDir) : undefined,
      workflowType,
      namespaceOverride,
      temporalCliPath,
      source,
      jsonOutput,
      debug,
    }
  }

  return {
    historyFile: historyFile ? resolve(cwd(), historyFile) : undefined,
    execution,
    workflowType,
    namespaceOverride,
    temporalCliPath,
    source,
    jsonOutput,
    debug,
  }
}

export const parseExecutionFlag = (value: string): WorkflowExecutionRef => {
  const trimmed = value.trim()
  const separatorIndex = trimmed.indexOf('/')
  if (separatorIndex === -1) {
    throw new ReplayCommandError('Execution must be formatted as <workflowId>/<runId>')
  }
  const workflowId = trimmed.slice(0, separatorIndex).trim()
  const runId = trimmed.slice(separatorIndex + 1).trim()
  if (!workflowId || !runId) {
    throw new ReplayCommandError('Execution flag requires both workflowId and runId (e.g., wf-123/run-456)')
  }
  return { workflowId, runId }
}

const loadReplayHistory = async (
  options: ReplaySingleOptions,
  config: TemporalConfig,
  workflowService: WorkflowServiceClient,
): Promise<HistoryLoadOutcome> => {
  if (options.historyFile) {
    return {
      record: await loadHistoryFromFile(options.historyFile),
      attempts: [],
    }
  }

  if (!options.execution) {
    throw new ReplayCommandError('Replay requires either --history-file or --execution')
  }

  return loadExecutionHistory({
    options: options as ReplayExecutionOptions,
    config,
    workflowService,
    loaders: defaultHistoryLoaders,
  })
}

const listHistoryFiles = async (historyDir: string): Promise<string[]> => {
  const files: string[] = []
  const queue: string[] = [historyDir]

  while (queue.length > 0) {
    const dir = queue.shift()
    if (!dir) continue
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        queue.push(fullPath)
        continue
      }
      const ext = extname(entry.name).toLowerCase()
      if (ext === '.json') {
        files.push(fullPath)
      }
    }
  }

  return files.sort()
}

const writeReplayBatchArtifacts = async (options: {
  readonly outDir: string
  readonly historyDir: string
  readonly summaries: readonly ReplaySummary[]
  readonly startedAtIso: string
  readonly durationMs: number
}): Promise<{ reportPath: string }> => {
  const outDir = options.outDir
  const perHistoryDir = resolve(outDir, 'replay-report')
  await mkdir(perHistoryDir, { recursive: true })

  for (const summary of options.summaries) {
    const description = summary.history.description
    const relativePath = description.startsWith(options.historyDir)
      ? relative(options.historyDir, description)
      : basename(description)
    const safe = relativePath.replace(/[\\/]/g, '__')
    const path = resolve(perHistoryDir, safe)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(summary, null, 2))
  }

  const reportPath = resolve(outDir, 'replay-report.json')
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        historyDir: options.historyDir,
        startedAtIso: options.startedAtIso,
        durationMs: options.durationMs,
        summaries: options.summaries,
      },
      null,
      2,
    ),
  )
  return { reportPath }
}

const executeReplayDirectoryInternal = (
  options: ReplayDirectoryOptions,
): Effect.Effect<
  ReplayBatchResult,
  ReplayCommandError,
  TemporalConfigService | ObservabilityService | WorkflowServiceClientService
> =>
  Effect.gen(function* () {
    const startTime = Date.now()
    const { logger } = yield* ObservabilityService

    const files = yield* Effect.tryPromise({
      try: () => listHistoryFiles(options.historyDir),
      catch: (error) =>
        new ReplayCommandError(`Failed to read history directory at ${options.historyDir}`, { cause: error }),
    })
    if (files.length === 0) {
      throw new ReplayCommandError(`No history JSON files found under ${options.historyDir}`)
    }

    yield* logger.log('info', 'temporal-bun replay directory started', {
      historyDir: options.historyDir,
      fileCount: files.length,
    })

    const summaries: ReplaySummary[] = []
    let exitCode = 0
    for (const filePath of files) {
      const run = yield* executeReplayInternal({
        historyFile: filePath,
        execution: undefined,
        workflowType: options.workflowType,
        namespaceOverride: options.namespaceOverride,
        temporalCliPath: options.temporalCliPath,
        source: options.source,
        jsonOutput: options.jsonOutput,
        debug: options.debug,
      })
      summaries.push(run.summary)
      if (run.exitCode === 2) {
        exitCode = 2
      } else if (run.exitCode !== 0 && exitCode === 0) {
        exitCode = run.exitCode
      }
    }

    const durationMs = Date.now() - startTime
    const startedAtIso = new Date(startTime).toISOString()
    const status: ReplayBatchResult['status'] = exitCode === 2 ? 'nondeterministic' : 'ok'

    let reportPath: string | undefined
    if (options.outDir) {
      const outcome = yield* Effect.tryPromise({
        try: () =>
          writeReplayBatchArtifacts({
            outDir: options.outDir,
            historyDir: options.historyDir,
            summaries,
            startedAtIso,
            durationMs,
          }),
        catch: (error) => new ReplayCommandError('Failed to write replay artifacts', { cause: error }),
      })
      reportPath = outcome.reportPath
    }

    yield* logger.log('info', 'temporal-bun replay directory completed', {
      historyDir: options.historyDir,
      status,
      durationMs,
      mismatches: summaries.reduce((sum, s) => sum + s.determinism.mismatchCount, 0),
      reportPath,
    })

    return {
      exitCode,
      summaries,
      historyDir: options.historyDir,
      ...(options.outDir ? { outDir: options.outDir } : {}),
      ...(reportPath ? { reportPath } : {}),
      startedAtIso,
      durationMs,
      status,
    }
  })

const loadHistoryFromFile = async (filePath: string): Promise<HistorySourceRecord> => {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    const events = decodeHistoryJson(parsed)
    if (events.length === 0) {
      throw new ReplayCommandError(`History file at ${filePath} did not include any workflow events`)
    }
    const metadata = extractHistoryMetadata(parsed)
    return {
      events,
      source: 'file',
      description: filePath,
      metadata,
    }
  } catch (error) {
    if (error instanceof ReplayCommandError) {
      throw error
    }
    throw new ReplayCommandError(`Failed to read history file at ${filePath}`, {
      cause: error,
    })
  }
}

const loadExecutionHistory = async ({
  options,
  config,
  loaders,
  workflowService,
}: {
  readonly options: ReplayExecutionOptions
  readonly config: TemporalConfig
  readonly loaders: HistoryLoaders
  readonly workflowService: WorkflowServiceClient
}): Promise<HistoryLoadOutcome> => {
  const attempts: HistoryLoaderAttempt[] = []
  const namespace = options.namespaceOverride ?? config.namespace

  const tryCli = options.source === 'cli' || options.source === 'auto'
  const tryService = options.source === 'service' || options.source === 'auto'

  if (tryCli) {
    try {
      const record = await loaders.cli({
        options,
        config,
        namespace,
      })
      return { record, attempts }
    } catch (error) {
      const message = describeHistoryLoaderError(error)
      attempts.push({ source: 'cli', error: message })
      if (options.source === 'cli') {
        throw new ReplayCommandError('Temporal CLI history fetch failed', { attempts })
      }
    }
  }

  if (tryService) {
    try {
      const record = await loaders.service({
        options,
        config,
        namespace,
        workflowService,
      })
      return { record, attempts }
    } catch (error) {
      const message = describeHistoryLoaderError(error)
      attempts.push({ source: 'service', error: message })
      throw new ReplayCommandError('WorkflowService history fetch failed', { attempts })
    }
  }

  throw new ReplayCommandError('No history source was attempted', { attempts })
}

async function loadHistoryViaCli({
  options,
  config,
  namespace,
}: {
  readonly options: ReplayExecutionOptions
  readonly config: TemporalConfig
  readonly namespace: string
}): Promise<HistorySourceRecord> {
  const binary = options.temporalCliPath ?? 'temporal'
  const args = [
    'workflow',
    'show',
    '--workflow-id',
    options.execution.workflowId,
    '--run-id',
    options.execution.runId,
    '--namespace',
    namespace,
    '--output',
    'json',
  ] as const

  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    child = Bun.spawn([binary, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: buildCliEnv(config, namespace),
    })
  } catch (error) {
    throw new ReplayCommandError(`Temporal CLI binary not found at ${binary}`, { cause: error })
  }

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    readStream(child.stdout),
    readStream(child.stderr),
  ])

  if (exitCode !== 0) {
    throw new ReplayCommandError('Temporal CLI returned a non-zero exit code', {
      exitCode,
      stderr,
      stdout,
    })
  }

  try {
    const parsed = JSON.parse(stdout) as unknown
    const events = decodeHistoryJson(parsed)
    if (events.length === 0) {
      throw new ReplayCommandError('Temporal CLI returned an empty history response')
    }
    return {
      events,
      source: 'cli',
      description: `${binary} ${args.join(' ')}`,
      metadata: {
        workflowId: options.execution.workflowId,
        runId: options.execution.runId,
        namespace,
      },
    }
  } catch (error) {
    if (error instanceof ReplayCommandError) {
      throw error
    }
    throw new ReplayCommandError('Failed to parse Temporal CLI history output', { cause: error, stdout })
  }
}

const buildCliEnv = (config: TemporalConfig, namespace: string): Record<string, string> => {
  const env: Record<string, string> = {
    ...process.env,
  }
  env.TEMPORAL_ADDRESS = config.address
  env.TEMPORAL_NAMESPACE = namespace
  if (config.allowInsecureTls) {
    env.TEMPORAL_ALLOW_INSECURE = '1'
    env.ALLOW_INSECURE_TLS = '1'
  }
  const forwarded = [
    'TEMPORAL_TLS_CA_PATH',
    'TEMPORAL_TLS_CERT_PATH',
    'TEMPORAL_TLS_KEY_PATH',
    'TEMPORAL_TLS_SERVER_NAME',
    'TEMPORAL_API_KEY',
    'TEMPORAL_CLOUD_API_KEY',
  ]
  for (const key of forwarded) {
    const value = process.env[key]
    if (value) {
      env[key] = value
    }
  }
  return env
}

async function loadHistoryViaService({
  options,
  config,
  namespace,
  workflowService,
}: {
  readonly options: ReplayExecutionOptions
  readonly config: TemporalConfig
  readonly namespace: string
  readonly workflowService: WorkflowServiceClient
}): Promise<HistorySourceRecord> {
  const events: HistoryEvent[] = []
  let nextPageToken: HistoryPageToken = new Uint8Array()

  try {
    do {
      const request = create(GetWorkflowExecutionHistoryRequestSchema, {
        namespace,
        execution: create(WorkflowExecutionSchema, {
          workflowId: options.execution.workflowId,
          runId: options.execution.runId,
        }),
        maximumPageSize: 0,
        nextPageToken: nextPageToken.length > 0 ? nextPageToken : undefined,
        waitNewEvent: false,
        historyEventFilterType: HistoryEventFilterType.ALL_EVENT,
        skipArchival: true,
      })
      const response = await workflowService.getWorkflowExecutionHistory(request, {
        timeoutMs: 60_000,
      })
      if (response.history?.events) {
        for (const event of response.history.events) {
          events.push(normalizeEventTypeFlag(event))
        }
      }
      nextPageToken = response.nextPageToken ?? new Uint8Array()
    } while (nextPageToken.length > 0)
  } catch (error) {
    throw new ReplayCommandError('WorkflowService GetWorkflowExecutionHistory failed', { cause: error })
  }

  if (events.length === 0) {
    throw new ReplayCommandError('WorkflowService returned an empty history response')
  }

  return {
    events,
    source: 'service',
    description: `${config.address} (WorkflowService)`,
    metadata: {
      workflowId: options.execution.workflowId,
      runId: options.execution.runId,
      namespace,
    },
  }
}

const decodeHistoryJson = (document: unknown): HistoryEvent[] => {
  const normalized = normalizeHistoryJson(stripTypeAnnotations(document)) as JsonValue
  const history = fromJson(HistorySchema, normalized)
  if (!history.events || history.events.length === 0) {
    return []
  }
  return history.events.map((event) => normalizeEventTypeFlag(event))
}

const normalizeHistoryJson = (input: unknown): unknown => {
  if (Array.isArray(input)) {
    return { events: input }
  }
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>
    if (Array.isArray(record.events)) {
      return { events: record.events }
    }
    if (Array.isArray(record.history)) {
      return { events: record.history }
    }
    if (record.history && typeof record.history === 'object') {
      const history = record.history as Record<string, unknown>
      if (Array.isArray(history.events)) {
        return { events: history.events }
      }
    }
    if (record.historyJson) {
      return record.historyJson
    }
  }
  return input
}

const normalizeEventTypeFlag = (event: HistoryEvent): HistoryEvent => {
  if (event.eventType && typeof event.eventType !== 'number') {
    const raw = String(event.eventType)
    const key = raw.startsWith('EVENT_TYPE_') ? raw.replace('EVENT_TYPE_', '') : raw
    const numeric = EVENT_TYPE_LOOKUP[key]
    if (typeof numeric === 'number') {
      event.eventType = numeric as typeof event.eventType
    }
  }
  return event
}

const extractHistoryMetadata = (document: unknown): HistoryMetadata => {
  const metadata: Mutable<HistoryMetadata> = {}
  if (document && typeof document === 'object') {
    const record = document as Record<string, unknown>
    if (isRecord(record.info)) {
      const info = record.info
      metadata.workflowType = readOptionalString(info.workflowType)
      metadata.namespace = readOptionalString(info.namespace)
      metadata.taskQueue = readOptionalString(info.taskQueue)
      metadata.workflowId = readOptionalString(info.workflowId)
      metadata.runId = readOptionalString(info.runId)
      metadata.temporalVersion = readOptionalString(info.temporalVersion)
    }
    if (isRecord(record.workflowExecutionInfo)) {
      const info = record.workflowExecutionInfo
      if (isRecord(info.execution)) {
        metadata.workflowId = metadata.workflowId ?? readOptionalString(info.execution.workflowId)
        metadata.runId = metadata.runId ?? readOptionalString(info.execution.runId)
      }
      if (isRecord(info.type)) {
        metadata.workflowType = metadata.workflowType ?? readOptionalString(info.type.name)
      }
      metadata.namespace = metadata.namespace ?? readOptionalString(info.namespace)
    }
  }
  return metadata
}

const resolveWorkflowInfo = ({
  config,
  options,
  metadata,
}: {
  readonly config: TemporalConfig
  readonly options: ReplaySingleOptions
  readonly metadata: HistoryMetadata
}): WorkflowInfo => {
  const workflowType = options.workflowType ?? metadata.workflowType
  if (!workflowType) {
    throw new ReplayCommandError(
      'Workflow type is required. Pass --workflow-type or include it in the history metadata.',
    )
  }

  const workflowId = metadata.workflowId ?? options.execution?.workflowId ?? 'history-file'
  const runId = metadata.runId ?? options.execution?.runId ?? 'history-run'
  const namespace = options.namespaceOverride ?? metadata.namespace ?? config.namespace
  const taskQueue = metadata.taskQueue ?? config.taskQueue

  return {
    namespace,
    taskQueue,
    workflowId,
    runId,
    workflowType,
  }
}

const readOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const readStringFlag = (value: string | boolean | undefined): string | undefined =>
  typeof value === 'string' ? value.trim() || undefined : undefined

const readBooleanFlag = (value: string | boolean | undefined): boolean => {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value !== 'string') {
    return false
  }
  const normalized = value.trim().toLowerCase()
  return ['1', 'true', 'yes', 'y'].includes(normalized)
}

const describeHistoryLoaderError = (error: unknown): string => {
  if (error instanceof ReplayCommandError) {
    return error.message
  }
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

const readStream = async (stream: BunReadableStream): Promise<string> => {
  if (!stream || typeof stream === 'number') {
    return ''
  }
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  const chunks: string[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    if (value) {
      chunks.push(decoder.decode(value, { stream: true }))
    }
  }
  chunks.push(decoder.decode())
  return chunks.join('')
}

export const printReplaySummary = (result: ReplayRunResult | ReplayBatchResult, jsonOutput: boolean): void => {
  if ('summary' in result) {
    const summary = result.summary
    const lines = [
      `temporal-bun replay (${summary.history.source})`,
      `  workflow: ${summary.workflow.workflowType} ${summary.workflow.workflowId}/${summary.workflow.runId}`,
      `  namespace: ${summary.workflow.namespace}`,
      `  history source: ${summary.history.description}`,
      `  events processed: ${summary.history.eventCount}`,
      `  last event id: ${summary.history.lastEventId ?? 'n/a'}`,
      `  determinism marker: ${summary.determinism.hasMarker ? 'found' : 'not found'}`,
      `  mismatches: ${summary.determinism.mismatchCount}`,
      ...(summary.determinism.ignoredMismatchCount
        ? [`  ignored mismatches: ${summary.determinism.ignoredMismatchCount}`]
        : []),
      `  duration: ${summary.durationMs}ms`,
    ]
    for (const line of lines) {
      console.log(line)
    }

    if (summary.determinism.mismatchCount > 0) {
      console.log('  mismatch details:')
      for (const mismatch of summary.determinism.mismatches) {
        console.log(`    - ${formatMismatchLine(mismatch)}`)
      }
    }
    if (summary.determinism.ignoredMismatchCount && summary.determinism.ignoredMismatches) {
      console.log('  ignored mismatch details:')
      for (const mismatch of summary.determinism.ignoredMismatches) {
        console.log(`    - ${formatMismatchLine(mismatch)}`)
      }
    }

    if (jsonOutput) {
      console.log(JSON.stringify(summary))
    }
    return
  }

  const mismatches = result.summaries.reduce((sum, s) => sum + s.determinism.mismatchCount, 0)
  const ignored = result.summaries.reduce((sum, s) => sum + (s.determinism.ignoredMismatchCount ?? 0), 0)
  console.log('temporal-bun replay (directory)')
  console.log(`  history dir: ${result.historyDir}`)
  console.log(`  histories: ${result.summaries.length}`)
  console.log(`  mismatches: ${mismatches}`)
  if (ignored > 0) {
    console.log(`  ignored mismatches: ${ignored}`)
  }
  console.log(`  duration: ${result.durationMs}ms`)
  if (result.reportPath) {
    console.log(`  report: ${result.reportPath}`)
  }

  if (mismatches > 0) {
    console.log('  mismatch summaries:')
    for (const summary of result.summaries) {
      if (summary.determinism.mismatchCount === 0) continue
      console.log(
        `    - ${summary.workflow.workflowType} ${summary.workflow.workflowId}/${summary.workflow.runId}: ${summary.determinism.mismatchCount}`,
      )
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify(result))
  }
}

const formatMismatchLine = (mismatch: DeterminismDiffResult['mismatches'][number]): string => {
  if (mismatch.kind === 'command') {
    const eventId = mismatch.actualEventId ?? mismatch.expectedEventId ?? 'n/a'
    return `command #${mismatch.index} (event ${eventId})`
  }
  if (mismatch.kind === 'random') {
    return `random value #${mismatch.index}`
  }
  if (mismatch.kind === 'time') {
    return `time value #${mismatch.index}`
  }
  return 'mismatch'
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object')

const stripTypeAnnotations = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => stripTypeAnnotations(entry))
  }
  if (isRecord(value)) {
    const next: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (key === '$typeName') {
        continue
      }
      next[key] = stripTypeAnnotations(entry)
    }
    return next
  }
  return value
}

export const replayCommandTestHooks = {
  loadHistoryFromFile,
  loadExecutionHistory,
  executeReplay,
}
