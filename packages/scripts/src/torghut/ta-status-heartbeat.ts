export type TaStatusHeartbeatRecord = {
  topic: string
  partition?: number
  ingestTs: string
  eventTs: string
  symbol: string
  seq: number
  isFinal?: boolean
  source?: string
  watermarkLagMs?: number
  sourceLagMs?: number
  lastEventTs?: string
  lastInputEventTs?: string
  lastOutputEventTs?: string
  inputEventCount?: number
  outputEventCount?: number
  currentInputEventCount?: number
  currentOutputEventCount?: number
  currentRecordCount?: number
  inputRatePerSecond?: number
  outputRatePerSecond?: number
  microbarEventCount?: number
  signalEventCount?: number
  microbarRatePerSecond?: number
  signalRatePerSecond?: number
  clickhouseSinkEnabled?: boolean
  perSymbolLatestEventTs?: Record<string, string>
  marketSessionState?: string
  statusReason?: string
  status: string
  heartbeat?: boolean
  version?: number
}

type TaStatusHeartbeatEvaluationInput = {
  now: Date
  enforceFreshness: boolean
  maxLagSeconds: number
  topic: string
  heartbeat?: TaStatusHeartbeatRecord
}

export type TaStatusHeartbeatEvaluation = {
  summaryLine: string
  failures: string[]
  warnings: string[]
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

const parseTimestampMs = (value: string | undefined): number | undefined => {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

const lagSeconds = (now: Date, timestamp: string | undefined): number | undefined => {
  const tsMs = parseTimestampMs(timestamp)
  if (tsMs === undefined) return undefined
  return Math.max(0, Math.floor((now.getTime() - tsMs) / 1_000))
}

const stripSchemaRegistryPrefix = (bytes: Uint8Array): Uint8Array => {
  if (bytes.length >= 5 && bytes[0] === 0) {
    return bytes.subarray(5)
  }
  return bytes
}

const pushFinding = (enforce: boolean, failures: string[], warnings: string[], code: string, detail: string) => {
  const line = `${code}: ${detail}`
  if (enforce) {
    failures.push(line)
  } else {
    warnings.push(line)
  }
}

class AvroStatusReader {
  private offset = 0

  constructor(private readonly bytes: Uint8Array) {}

  readString(label: string): string {
    const length = this.readLong(`${label}.length`)
    if (length < 0) throw new Error(`${label} length is negative`)
    const end = this.offset + length
    if (end > this.bytes.length) throw new Error(`${label} exceeds Avro payload length`)
    const value = utf8Decoder.decode(this.bytes.slice(this.offset, end))
    this.offset = end
    return value
  }

  readLong(label: string): number {
    let raw = 0n
    let shift = 0n
    for (let i = 0; i < 10; i += 1) {
      const byte = this.readByte(label)
      raw |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) {
        const decoded = (raw >> 1n) ^ -(raw & 1n)
        if (decoded > BigInt(Number.MAX_SAFE_INTEGER) || decoded < BigInt(Number.MIN_SAFE_INTEGER)) {
          throw new Error(`${label} is outside the JavaScript safe integer range`)
        }
        return Number(decoded)
      }
      shift += 7n
    }
    throw new Error(`${label} Avro varint is too long`)
  }

  readInt(label: string): number {
    return this.readLong(label)
  }

  readBoolean(label: string): boolean {
    const byte = this.readByte(label)
    if (byte === 0) return false
    if (byte === 1) return true
    throw new Error(`${label} is not an Avro boolean`)
  }

  readDouble(label: string): number {
    this.requireBytes(label, 8)
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 8)
    const value = view.getFloat64(0, true)
    this.offset += 8
    return value
  }

  readNullableBoolean(label: string): boolean | undefined {
    const branch = this.readUnionBranch(label)
    if (branch === 0) return undefined
    if (branch === 1) return this.readBoolean(label)
    throw new Error(`${label} has unsupported Avro union branch ${branch}`)
  }

  readNullableLong(label: string): number | undefined {
    const branch = this.readUnionBranch(label)
    if (branch === 0) return undefined
    if (branch === 1) return this.readLong(label)
    throw new Error(`${label} has unsupported Avro union branch ${branch}`)
  }

  readNullableDouble(label: string): number | undefined {
    const branch = this.readUnionBranch(label)
    if (branch === 0) return undefined
    if (branch === 1) return this.readDouble(label)
    throw new Error(`${label} has unsupported Avro union branch ${branch}`)
  }

  readNullableString(label: string): string | undefined {
    const branch = this.readUnionBranch(label)
    if (branch === 0) return undefined
    if (branch === 1) return this.readString(label)
    throw new Error(`${label} has unsupported Avro union branch ${branch}`)
  }

  readNullableWindow(label: string): void {
    const branch = this.readUnionBranch(label)
    if (branch === 0) return
    if (branch !== 1) throw new Error(`${label} has unsupported Avro union branch ${branch}`)
    this.readString(`${label}.size`)
    this.readNullableString(`${label}.step`)
    this.readNullableString(`${label}.start`)
    this.readNullableString(`${label}.end`)
  }

  readNullableStringMap(label: string): Record<string, string> | undefined {
    const branch = this.readUnionBranch(label)
    if (branch === 0) return undefined
    if (branch !== 1) throw new Error(`${label} has unsupported Avro union branch ${branch}`)

    const output: Record<string, string> = {}
    while (true) {
      let blockCount = this.readLong(`${label}.block_count`)
      if (blockCount === 0) return output
      if (blockCount < 0) {
        blockCount = -blockCount
        this.readLong(`${label}.block_size`)
      }
      for (let i = 0; i < blockCount; i += 1) {
        const key = this.readString(`${label}.key`)
        output[key] = this.readString(`${label}.${key}`)
      }
    }
  }

  readNullableVersion(label: string): number | undefined {
    const branch = this.readUnionBranch(label)
    if (branch === 0) return this.readInt(label)
    if (branch === 1) return undefined
    throw new Error(`${label} has unsupported Avro union branch ${branch}`)
  }

  private readUnionBranch(label: string): number {
    return this.readLong(`${label}.union_branch`)
  }

  private readByte(label: string): number {
    this.requireBytes(label, 1)
    const value = this.bytes[this.offset]
    this.offset += 1
    return value
  }

  private requireBytes(label: string, length: number) {
    if (this.offset + length > this.bytes.length) {
      throw new Error(`${label} exceeds Avro payload length`)
    }
  }
}

export const decodeTaStatusHeartbeatAvro = (
  bytes: Uint8Array,
  metadata: { topic: string; partition?: number },
): TaStatusHeartbeatRecord => {
  const reader = new AvroStatusReader(stripSchemaRegistryPrefix(bytes))
  const ingestTs = reader.readString('ingest_ts')
  const eventTs = reader.readString('event_ts')
  const symbol = reader.readString('symbol')
  const seq = reader.readLong('seq')
  const isFinal = reader.readNullableBoolean('is_final')
  const source = reader.readNullableString('source')
  reader.readNullableWindow('window')
  const watermarkLagMs = reader.readNullableLong('watermark_lag_ms')
  const sourceLagMs = reader.readNullableLong('source_lag_ms')
  const lastEventTs = reader.readNullableString('last_event_ts')
  const lastInputEventTs = reader.readNullableString('last_input_event_ts')
  const lastOutputEventTs = reader.readNullableString('last_output_event_ts')
  const inputEventCount = reader.readNullableLong('input_event_count')
  const outputEventCount = reader.readNullableLong('output_event_count')
  const currentInputEventCount = reader.readNullableLong('current_input_event_count')
  const currentOutputEventCount = reader.readNullableLong('current_output_event_count')
  const currentRecordCount = reader.readNullableLong('current_record_count')
  const inputRatePerSecond = reader.readNullableDouble('input_rate_per_second')
  const outputRatePerSecond = reader.readNullableDouble('output_rate_per_second')
  const microbarEventCount = reader.readNullableLong('microbar_event_count')
  const signalEventCount = reader.readNullableLong('signal_event_count')
  const microbarRatePerSecond = reader.readNullableDouble('microbar_rate_per_second')
  const signalRatePerSecond = reader.readNullableDouble('signal_rate_per_second')
  const clickhouseSinkEnabled = reader.readNullableBoolean('clickhouse_sink_enabled')
  const perSymbolLatestEventTs = reader.readNullableStringMap('per_symbol_latest_event_ts')
  const marketSessionState = reader.readNullableString('market_session_state')
  const statusReason = reader.readNullableString('status_reason')
  const status = reader.readString('status')
  const heartbeat = reader.readNullableBoolean('heartbeat')
  const version = reader.readNullableVersion('version')

  return {
    topic: metadata.topic,
    partition: metadata.partition,
    ingestTs,
    eventTs,
    symbol,
    seq,
    isFinal,
    source,
    watermarkLagMs,
    sourceLagMs,
    lastEventTs,
    lastInputEventTs,
    lastOutputEventTs,
    inputEventCount,
    outputEventCount,
    currentInputEventCount,
    currentOutputEventCount,
    currentRecordCount,
    inputRatePerSecond,
    outputRatePerSecond,
    microbarEventCount,
    signalEventCount,
    microbarRatePerSecond,
    signalRatePerSecond,
    clickhouseSinkEnabled,
    perSymbolLatestEventTs,
    marketSessionState,
    statusReason,
    status,
    heartbeat,
    version,
  }
}

export const evaluateTaStatusHeartbeat = (input: TaStatusHeartbeatEvaluationInput): TaStatusHeartbeatEvaluation => {
  const failures: string[] = []
  const warnings: string[] = []
  const heartbeat = input.heartbeat
  if (!heartbeat) {
    return {
      summaryLine: `- TA status heartbeat: latest=\`missing\`, topic=\`${input.topic}\``,
      failures: input.enforceFreshness
        ? [`ta_status_heartbeat_missing: no decodeable heartbeat found on ${input.topic}`]
        : [],
      warnings: input.enforceFreshness
        ? []
        : [`ta_status_heartbeat_missing: no decodeable heartbeat found on ${input.topic}`],
    }
  }

  const heartbeatLag = lagSeconds(input.now, heartbeat.eventTs)
  const sourceLagSeconds = heartbeat.sourceLagMs === undefined ? undefined : Math.floor(heartbeat.sourceLagMs / 1_000)
  const summaryLine =
    `- TA status heartbeat: status=\`${heartbeat.status}\`, reason=\`${heartbeat.statusReason ?? 'ok'}\`, ` +
    `latest=\`${heartbeat.eventTs}\`, lag_seconds=\`${heartbeatLag ?? 'missing'}\`, ` +
    `source_lag_ms=\`${heartbeat.sourceLagMs ?? 'missing'}\`, ` +
    `last_input=\`${heartbeat.lastInputEventTs ?? 'missing'}\`, ` +
    `last_output=\`${heartbeat.lastOutputEventTs ?? 'missing'}\`, ` +
    `current_records=\`${heartbeat.currentRecordCount ?? 'missing'}\`, ` +
    `current_input=\`${heartbeat.currentInputEventCount ?? 'missing'}\`, ` +
    `current_output=\`${heartbeat.currentOutputEventCount ?? 'missing'}\`, ` +
    `microbar_rate=\`${heartbeat.microbarRatePerSecond ?? 'missing'}\`, ` +
    `signal_rate=\`${heartbeat.signalRatePerSecond ?? 'missing'}\`, ` +
    `clickhouse_sink_enabled=\`${heartbeat.clickhouseSinkEnabled ?? 'missing'}\`, ` +
    `session=\`${heartbeat.marketSessionState ?? 'missing'}\`, ` +
    `partition=\`${heartbeat.partition ?? 'unknown'}\``

  if (heartbeatLag === undefined) {
    pushFinding(
      input.enforceFreshness,
      failures,
      warnings,
      'ta_status_heartbeat_timestamp_missing',
      'TA status heartbeat has no parseable event_ts',
    )
  } else if (heartbeatLag > input.maxLagSeconds) {
    pushFinding(
      input.enforceFreshness,
      failures,
      warnings,
      'ta_status_heartbeat_stale',
      `TA status heartbeat lag ${heartbeatLag}s exceeds ${input.maxLagSeconds}s`,
    )
  }
  if (heartbeat.status !== 'ok') {
    pushFinding(
      input.enforceFreshness,
      failures,
      warnings,
      'ta_status_degraded',
      `TA status heartbeat status=${heartbeat.status} reason=${heartbeat.statusReason ?? 'missing'}`,
    )
  }
  if ((heartbeat.currentRecordCount ?? 0) <= 0) {
    pushFinding(
      input.enforceFreshness,
      failures,
      warnings,
      'ta_status_zero_current_records',
      'TA status heartbeat reports zero current input/output records',
    )
  }
  if ((heartbeat.currentInputEventCount ?? 0) <= 0) {
    pushFinding(
      input.enforceFreshness,
      failures,
      warnings,
      'ta_status_zero_current_input_records',
      'TA status heartbeat reports zero current input records',
    )
  }
  if ((heartbeat.currentOutputEventCount ?? 0) <= 0) {
    pushFinding(
      input.enforceFreshness,
      failures,
      warnings,
      'ta_status_zero_current_output_records',
      'TA status heartbeat reports zero current output records',
    )
  }
  if (sourceLagSeconds === undefined) {
    pushFinding(
      input.enforceFreshness,
      failures,
      warnings,
      'ta_status_source_lag_missing',
      'TA status heartbeat has no source_lag_ms',
    )
  } else if (sourceLagSeconds > input.maxLagSeconds) {
    pushFinding(
      input.enforceFreshness,
      failures,
      warnings,
      'ta_status_source_lag_stale',
      `TA status source lag ${sourceLagSeconds}s exceeds ${input.maxLagSeconds}s`,
    )
  }
  if (!heartbeat.lastInputEventTs) {
    pushFinding(
      input.enforceFreshness,
      failures,
      warnings,
      'ta_status_last_input_missing',
      'TA status heartbeat has no last_input_event_ts',
    )
  }
  if (!heartbeat.lastOutputEventTs) {
    pushFinding(
      input.enforceFreshness,
      failures,
      warnings,
      'ta_status_last_output_missing',
      'TA status heartbeat has no last_output_event_ts',
    )
  }
  if (heartbeat.clickhouseSinkEnabled !== true) {
    pushFinding(
      input.enforceFreshness,
      failures,
      warnings,
      'ta_status_clickhouse_sink_disabled',
      `TA status heartbeat clickhouse_sink_enabled=${heartbeat.clickhouseSinkEnabled ?? 'missing'}`,
    )
  }

  return { summaryLine, failures, warnings }
}
