#!/usr/bin/env bun

import { ensureCli, fatal, repoRoot, run } from '../shared/cli'

type JsonObject = Record<string, unknown>

type KafkaRole = 'trades' | 'quotes' | 'bars'

type SmokeMode = 'auto' | 'enforce' | 'observe'

type MarketSessionState = 'pre' | 'regular' | 'post' | 'closed' | 'weekend' | 'holiday'

type KafkaTopicRecord = {
  topic: string
  eventTs?: string
  channel?: string
  symbol?: string
}

type MarketDataSmokeInput = {
  now: Date
  mode: SmokeMode
  holidays: Set<string>
  maxKafkaLagSeconds: number
  acceptedMaxLagSeconds: number
  latestKafkaByRole: Partial<Record<KafkaRole, KafkaTopicRecord>>
  wsReadyz: unknown
  tradingStatus: unknown
  taRuntimeConfig?: TaRuntimeConfig
}

export type MarketDataSmokeResult = {
  ok: boolean
  enforceFreshness: boolean
  sessionState: MarketSessionState
  failures: string[]
  warnings: string[]
  summaryLines: string[]
}

type TaRuntimeConfig = {
  groupId?: string
  autoOffsetReset?: string
}

const DEFAULT_SUMMARY_TOPICS = [
  'torghut.trades.v1',
  'torghut.quotes.v1',
  'torghut.bars.1m.v1',
  'torghut.ta.bars.1s.v1',
  'torghut.ta.signals.v1',
  'torghut.ta.status.v1',
]

const DEFAULT_TOPIC_BY_ROLE: Record<KafkaRole, string> = {
  trades: 'torghut.trades.v1',
  quotes: 'torghut.quotes.v1',
  bars: 'torghut.bars.1m.v1',
}

const REQUIRED_WS_CHANNELS = ['trades', 'quotes', 'bars', 'updatedBars']
const REQUIRED_KAFKA_ROLES: KafkaRole[] = ['trades', 'quotes', 'bars']
const ACCEPTED_SOURCE_STALE_REASON = 'accepted_ta_signal_stale'

const parseList = (raw: string | undefined, fallback: string[]) =>
  raw
    ?.split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0) ?? fallback

const parsePositiveNumber = (raw: string | undefined, fallback: number, label: string): number => {
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fatal(`${label} must be a positive number`)
  }
  return parsed
}

const parseMode = (raw: string | undefined): SmokeMode => {
  const mode = (raw ?? 'auto').trim().toLowerCase()
  if (mode === 'auto' || mode === 'enforce' || mode === 'observe') return mode
  fatal('MARKET_DATA_FRESHNESS_MODE must be auto, enforce, or observe')
}

const isObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

const parseTimestampMs = (value: unknown): number | undefined => {
  const raw = asString(value)
  if (!raw) return undefined
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? undefined : parsed
}

const lagSeconds = (now: Date, timestamp: unknown): number | undefined => {
  const tsMs = parseTimestampMs(timestamp)
  if (tsMs === undefined) return undefined
  return Math.max(0, Math.floor((now.getTime() - tsMs) / 1_000))
}

const nyParts = (now: Date): Record<string, string> =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  )

export const marketSessionState = (now: Date, holidays: Set<string> = new Set()): MarketSessionState => {
  const parts = nyParts(now)
  const dateKey = `${parts.year}-${parts.month}-${parts.day}`
  if (holidays.has(dateKey)) return 'holiday'
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return 'weekend'

  const hour = Number(parts.hour) % 24
  const minute = Number(parts.minute)
  const minuteOfDay = hour * 60 + minute
  if (minuteOfDay >= 4 * 60 && minuteOfDay < 9 * 60 + 30) return 'pre'
  if (minuteOfDay >= 9 * 60 + 30 && minuteOfDay < 16 * 60) return 'regular'
  if (minuteOfDay >= 16 * 60 && minuteOfDay < 20 * 60) return 'post'
  return 'closed'
}

const shouldEnforceFreshness = (mode: SmokeMode, sessionState: MarketSessionState): boolean =>
  mode === 'enforce' || (mode === 'auto' && sessionState === 'regular')

const getWsChannels = (readyz: unknown): Map<string, JsonObject> => {
  const root = isObject(readyz) ? readyz : {}
  const channels = Array.isArray(root.market_data_channels) ? root.market_data_channels : []
  return new Map(
    channels
      .filter(isObject)
      .map((channel) => [asString(channel.channel) ?? '', channel])
      .filter(([channel]) => channel.length > 0),
  )
}

const getAcceptedFreshness = (status: unknown): JsonObject | undefined => {
  if (!isObject(status)) return undefined
  const liveSubmissionGate = isObject(status.live_submission_gate) ? status.live_submission_gate : undefined
  if (liveSubmissionGate && isObject(liveSubmissionGate.clickhouse_ta_freshness)) {
    return liveSubmissionGate.clickhouse_ta_freshness
  }
  if (isObject(status.clickhouse_ta_freshness)) return status.clickhouse_ta_freshness
  return undefined
}

const getTaRuntimeConfig = (data: unknown): TaRuntimeConfig | undefined => {
  if (!isObject(data)) return undefined
  return {
    groupId: asString(data.TA_GROUP_ID),
    autoOffsetReset: asString(data.TA_AUTO_OFFSET_RESET),
  }
}

const pushFinding = (enforce: boolean, failures: string[], warnings: string[], code: string, detail: string) => {
  const line = `${code}: ${detail}`
  if (enforce) {
    failures.push(line)
  } else {
    warnings.push(line)
  }
}

const summarizeKafkaRole = (
  now: Date,
  role: KafkaRole,
  record: KafkaTopicRecord | undefined,
  maxLagSeconds: number,
): { line: string; stale: boolean; detail: string } => {
  const latest = record?.eventTs
  const lag = lagSeconds(now, latest)
  if (!record || !latest || lag === undefined) {
    return {
      line: `- Kafka ${role}: latest=\`missing\` topic=\`${record?.topic ?? DEFAULT_TOPIC_BY_ROLE[role]}\``,
      stale: true,
      detail: `${role} has no parseable latest event timestamp`,
    }
  }
  return {
    line:
      `- Kafka ${role}: latest=\`${latest}\`, lag_seconds=\`${lag}\`, ` +
      `symbol=\`${record.symbol ?? 'unknown'}\`, topic=\`${record.topic}\``,
    stale: lag > maxLagSeconds,
    detail: `${role} latest event lag ${lag}s exceeds ${maxLagSeconds}s`,
  }
}

export const evaluateMarketDataSmoke = (input: MarketDataSmokeInput): MarketDataSmokeResult => {
  const sessionState = marketSessionState(input.now, input.holidays)
  const enforceFreshness = shouldEnforceFreshness(input.mode, sessionState)
  const failures: string[] = []
  const warnings: string[] = []
  const summaryLines = [
    `- Market session: \`${sessionState}\``,
    `- Freshness mode: \`${input.mode}\`, enforced=\`${enforceFreshness}\``,
  ]

  const taGroupId = input.taRuntimeConfig?.groupId
  const taAutoOffsetReset = input.taRuntimeConfig?.autoOffsetReset
  summaryLines.push(
    `- TA runtime config: group_id=\`${taGroupId ?? 'missing'}\`, auto_offset_reset=\`${taAutoOffsetReset ?? 'missing'}\``,
  )
  if (!taGroupId) {
    failures.push('ta_group_id_missing: torghut-ta-config is missing TA_GROUP_ID')
  } else if (taGroupId.toLowerCase().includes('replay')) {
    failures.push(`ta_replay_group_enabled: production TA_GROUP_ID must not be replay-scoped (${taGroupId})`)
  }
  if ((taAutoOffsetReset ?? '').toLowerCase() !== 'latest') {
    failures.push(
      `ta_auto_offset_reset_not_latest: production TA_AUTO_OFFSET_RESET must be latest (${taAutoOffsetReset ?? 'missing'})`,
    )
  }

  const wsChannels = getWsChannels(input.wsReadyz)
  for (const channel of REQUIRED_WS_CHANNELS) {
    const status = wsChannels.get(channel)
    const ready = status?.ready === true
    const subscribed = asNumber(status?.subscribed_symbol_count) ?? 0
    const observed = asNumber(status?.observed_symbol_count) ?? 0
    const reason = asString(status?.reason) ?? 'missing'
    summaryLines.push(
      `- WS ${channel}: ready=\`${ready}\`, subscribed=\`${subscribed}\`, observed=\`${observed}\`, reason=\`${reason}\``,
    )
    if (!ready || subscribed <= 0) {
      pushFinding(
        enforceFreshness,
        failures,
        warnings,
        `ws_${channel}_not_ready`,
        `WS channel ${channel} ready=${ready} subscribed_symbol_count=${subscribed} reason=${reason}`,
      )
    }
    if (enforceFreshness && status?.latest_kafka_success_at_ms === null) {
      failures.push(`ws_${channel}_missing_kafka_success: WS channel ${channel} has no Kafka success timestamp`)
    }
  }

  for (const role of REQUIRED_KAFKA_ROLES) {
    const summary = summarizeKafkaRole(input.now, role, input.latestKafkaByRole[role], input.maxKafkaLagSeconds)
    summaryLines.push(summary.line)
    if (summary.stale) {
      pushFinding(enforceFreshness, failures, warnings, `kafka_${role}_stale`, summary.detail)
    }
  }

  const freshness = getAcceptedFreshness(input.tradingStatus)
  const acceptedState = asString(freshness?.accepted_source_state) ?? 'missing'
  const blockingReason = asString(freshness?.blocking_reason) ?? 'missing'
  const latestAccepted = asString(freshness?.latest_accepted_event_at)
  const acceptedLag = asNumber(freshness?.accepted_lag_seconds) ?? lagSeconds(input.now, latestAccepted)
  const acceptedMaxLag = asNumber(freshness?.accepted_max_lag_seconds) ?? input.acceptedMaxLagSeconds
  const acceptedSources = Array.isArray(freshness?.accepted_sources)
    ? freshness.accepted_sources.map((source) => asString(source) ?? '').filter(Boolean)
    : []
  summaryLines.push(
    `- Accepted TA: state=\`${acceptedState}\`, latest=\`${latestAccepted ?? 'missing'}\`, ` +
      `lag_seconds=\`${acceptedLag ?? 'missing'}\`, max_lag_seconds=\`${acceptedMaxLag}\`, ` +
      `blocking_reason=\`${blockingReason}\`, sources=\`${acceptedSources.join(',') || 'missing'}\``,
  )

  if (!acceptedSources.includes('ta')) {
    pushFinding(
      enforceFreshness,
      failures,
      warnings,
      'accepted_ta_source_missing',
      'accepted_sources does not include ta',
    )
  }
  const unexpectedAcceptedSources = acceptedSources.filter((source) => source !== 'ta')
  if (unexpectedAcceptedSources.length > 0) {
    pushFinding(
      enforceFreshness,
      failures,
      warnings,
      'accepted_source_contains_backfill',
      `accepted_sources includes non-live source(s): ${unexpectedAcceptedSources.join(',')}`,
    )
  }
  if (!latestAccepted || acceptedLag === undefined) {
    pushFinding(
      enforceFreshness,
      failures,
      warnings,
      'accepted_ta_timestamp_missing',
      'accepted TA freshness has no parseable latest_accepted_event_at',
    )
  } else if (acceptedLag > acceptedMaxLag) {
    pushFinding(
      enforceFreshness,
      failures,
      warnings,
      'accepted_ta_stale',
      `accepted TA lag ${acceptedLag}s exceeds ${acceptedMaxLag}s`,
    )
  }
  if (acceptedState === 'stale' || blockingReason === ACCEPTED_SOURCE_STALE_REASON) {
    pushFinding(
      enforceFreshness,
      failures,
      warnings,
      ACCEPTED_SOURCE_STALE_REASON,
      `accepted_source_state=${acceptedState} blocking_reason=${blockingReason}`,
    )
  }

  return {
    ok: failures.length === 0,
    enforceFreshness,
    sessionState,
    failures,
    warnings,
    summaryLines,
  }
}

const execCapture = async (
  command: string,
  args: string[],
  options: { cwd?: string; stdin?: string; env?: Record<string, string | undefined> } = {},
) => {
  const subprocess = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    stdin: options.stdin ? 'pipe' : 'inherit',
    stdout: 'pipe',
    stderr: 'pipe',
    env: options.env ? { ...process.env, ...options.env } : process.env,
  })

  if (options.stdin !== undefined) {
    void subprocess.stdin.write(options.stdin)
    void subprocess.stdin.end()
  }

  const stdout = await new Response(subprocess.stdout).text()
  const stderr = await new Response(subprocess.stderr).text()
  const exitCode = await subprocess.exited
  if (exitCode !== 0) {
    fatal(`Command failed (${exitCode}): ${command} ${args.join(' ')}`.trim(), stderr || stdout)
  }
  return stdout
}

const tailArgs = (topic: string, format: 'summary' | 'json', settings: RuntimeSettings) => [
  'run',
  'packages/scripts/src/kafka/tail-topic.ts',
  '--topic',
  topic,
  '--tail',
  settings.tail,
  '--timeout-ms',
  settings.timeoutMs,
  '--username',
  settings.username,
  '--password-secret-namespace',
  settings.passwordSecretNamespace,
  '--password-secret-name',
  settings.passwordSecretName,
  '--password-secret-key',
  settings.passwordSecretKey,
  '--format',
  format,
]

const captureLatestKafkaRecord = async (
  role: KafkaRole,
  topic: string,
  settings: RuntimeSettings,
): Promise<KafkaTopicRecord | undefined> => {
  const stdout = await execCapture('bun', tailArgs(topic, 'json', settings), { cwd: repoRoot })
  const parsed = JSON.parse(stdout) as unknown
  if (!Array.isArray(parsed)) {
    fatal(`Kafka tail for ${topic} did not return a JSON array`)
  }
  const records = parsed.filter(isObject)
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]
    const eventTs = asString(record.eventTs)
    if (!eventTs) continue
    return {
      topic,
      eventTs,
      channel: asString(record.channel) ?? role,
      symbol: asString(record.symbol),
    }
  }
  return undefined
}

const fetchJsonViaWsPod = async (url: string, settings: RuntimeSettings): Promise<unknown> => {
  const stdout = await execCapture('kubectl', [
    'exec',
    '-n',
    settings.torghutNamespace,
    settings.wsExecTarget,
    '--',
    'wget',
    '-qO-',
    url,
  ])
  return JSON.parse(stdout) as unknown
}

type RuntimeSettings = {
  topics: string[]
  topicByRole: Record<KafkaRole, string>
  username: string
  passwordSecretNamespace: string
  passwordSecretName: string
  passwordSecretKey: string
  tail: string
  timeoutMs: string
  mode: SmokeMode
  maxKafkaLagSeconds: number
  acceptedMaxLagSeconds: number
  holidays: Set<string>
  now: Date
  printSummaries: boolean
  torghutNamespace: string
  wsExecTarget: string
  wsReadyzUrl: string
  tradingStatusUrl: string
  taConfigMapName: string
}

const runtimeSettings = (): RuntimeSettings => ({
  topics: parseList(process.env.TORGHUT_MARKET_DATA_TOPICS, DEFAULT_SUMMARY_TOPICS),
  topicByRole: {
    trades: process.env.TORGHUT_TRADES_TOPIC ?? DEFAULT_TOPIC_BY_ROLE.trades,
    quotes: process.env.TORGHUT_QUOTES_TOPIC ?? DEFAULT_TOPIC_BY_ROLE.quotes,
    bars: process.env.TORGHUT_BARS_TOPIC ?? DEFAULT_TOPIC_BY_ROLE.bars,
  },
  username: process.env.KAFKA_USERNAME ?? 'torghut-ws',
  passwordSecretNamespace: process.env.KAFKA_PASSWORD_SECRET_NAMESPACE ?? 'torghut',
  passwordSecretName: process.env.KAFKA_PASSWORD_SECRET_NAME ?? 'torghut-ws',
  passwordSecretKey: process.env.KAFKA_PASSWORD_SECRET_KEY ?? 'password',
  tail: process.env.TAIL ?? '1',
  timeoutMs: process.env.TIMEOUT_MS ?? '8000',
  mode: parseMode(process.env.MARKET_DATA_FRESHNESS_MODE),
  maxKafkaLagSeconds: parsePositiveNumber(process.env.MARKET_DATA_MAX_LAG_SECONDS, 300, 'MARKET_DATA_MAX_LAG_SECONDS'),
  acceptedMaxLagSeconds: parsePositiveNumber(
    process.env.MARKET_DATA_ACCEPTED_MAX_LAG_SECONDS,
    300,
    'MARKET_DATA_ACCEPTED_MAX_LAG_SECONDS',
  ),
  holidays: new Set(parseList(process.env.MARKET_DATA_HOLIDAYS, [])),
  now: process.env.MARKET_DATA_NOW ? new Date(process.env.MARKET_DATA_NOW) : new Date(),
  printSummaries: process.env.MARKET_DATA_PRINT_SUMMARIES !== 'false',
  torghutNamespace: process.env.TORGHUT_NAMESPACE ?? 'torghut',
  wsExecTarget: process.env.TORGHUT_WS_EXEC_TARGET ?? 'deploy/torghut-ws',
  wsReadyzUrl: process.env.TORGHUT_WS_READYZ_URL ?? 'http://127.0.0.1:8080/readyz',
  tradingStatusUrl: process.env.TORGHUT_STATUS_URL ?? 'http://torghut.torghut.svc.cluster.local/trading/status',
  taConfigMapName: process.env.TORGHUT_TA_CONFIGMAP ?? 'torghut-ta-config',
})

const fetchConfigMapData = async (namespace: string, name: string): Promise<TaRuntimeConfig | undefined> => {
  const stdout = await execCapture('kubectl', ['get', 'configmap', '-n', namespace, name, '-o', 'json'])
  const parsed = JSON.parse(stdout) as unknown
  const data = isObject(parsed) ? parsed.data : undefined
  return getTaRuntimeConfig(data)
}

const main = async () => {
  ensureCli('kubectl')

  const settings = runtimeSettings()
  if (Number.isNaN(settings.now.getTime())) {
    fatal('MARKET_DATA_NOW must be a parseable timestamp when set')
  }

  if (settings.printSummaries) {
    for (const topic of settings.topics) {
      await run('bun', tailArgs(topic, 'summary', settings), { cwd: repoRoot })
    }
  }

  const latestKafkaByRole: Partial<Record<KafkaRole, KafkaTopicRecord>> = {}
  for (const role of REQUIRED_KAFKA_ROLES) {
    latestKafkaByRole[role] = await captureLatestKafkaRecord(role, settings.topicByRole[role], settings)
  }

  const wsReadyz = await fetchJsonViaWsPod(settings.wsReadyzUrl, settings)
  const tradingStatus = await fetchJsonViaWsPod(settings.tradingStatusUrl, settings)
  const taRuntimeConfig = await fetchConfigMapData(settings.torghutNamespace, settings.taConfigMapName)
  const result = evaluateMarketDataSmoke({
    now: settings.now,
    mode: settings.mode,
    holidays: settings.holidays,
    maxKafkaLagSeconds: settings.maxKafkaLagSeconds,
    acceptedMaxLagSeconds: settings.acceptedMaxLagSeconds,
    latestKafkaByRole,
    wsReadyz,
    tradingStatus,
    taRuntimeConfig,
  })

  console.log('Torghut market-data freshness evidence:')
  for (const line of result.summaryLines) console.log(line)
  for (const warning of result.warnings) console.warn(`warning: ${warning}`)
  if (!result.ok) {
    fatal(`Torghut market-data freshness check failed\n${result.failures.join('\n')}`)
  }
}

if (import.meta.main) {
  main().catch((err) => fatal('Torghut market-data smoke failed', err))
}
