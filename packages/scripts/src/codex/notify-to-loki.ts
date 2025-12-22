#!/usr/bin/env bun

import os from 'node:os'

type NotifyPayload = {
  type?: string
  'thread-id'?: string
  'turn-id'?: string
  cwd?: string
  'input-messages'?: string[]
  'last-assistant-message'?: string
  [key: string]: unknown
}

type LokiStream = {
  stream: Record<string, string>
  values: [string, string][]
}

type BuildStreamsOptions = {
  originator?: string
  hostname?: string
  includeInputs?: boolean
  extraLabels?: Record<string, string>
  now?: Date
}

const readStdin = async () => {
  const chunks: Uint8Array[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Uint8Array)
  }
  return Buffer.concat(chunks).toString('utf8').trim()
}

const parsePayload = async () => {
  const args = process.argv.slice(2)
  if (args[0] && args[0] !== '--stdin') {
    return args[0]
  }
  return readStdin()
}

const compactObject = <T extends Record<string, unknown>>(input: T) => {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null))
}

const parseExtraLabels = () => {
  if (!process.env.CODEX_NOTIFY_LOKI_LABELS) return undefined
  try {
    return JSON.parse(process.env.CODEX_NOTIFY_LOKI_LABELS) as Record<string, string>
  } catch (error) {
    console.error('Invalid CODEX_NOTIFY_LOKI_LABELS JSON:', error)
    return undefined
  }
}

export const buildStreams = (payload: NotifyPayload, options: BuildStreamsOptions = {}) => {
  const originator = options.originator || process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE || 'codex_cli_rs'
  const includeInputs = options.includeInputs ?? process.env.CODEX_NOTIFY_INCLUDE_INPUTS === '1'
  const hostname = options.hostname || os.hostname()
  const now = options.now ?? new Date()
  const extraLabels = options.extraLabels ?? parseExtraLabels()

  const assistantText = typeof payload['last-assistant-message'] === 'string' ? payload['last-assistant-message'] : ''
  const nowNs = BigInt(now.getTime()) * 1_000_000n

  const event = compactObject({
    type: payload.type,
    thread_id: payload['thread-id'] || payload.thread_id,
    turn_id: payload['turn-id'] || payload.turn_id,
    cwd: payload.cwd,
    input_message_count: Array.isArray(payload['input-messages']) ? payload['input-messages'].length : undefined,
    input_messages: includeInputs ? payload['input-messages'] : undefined,
    assistant_message: assistantText,
    timestamp: now.toISOString(),
  })

  const labels: Record<string, string> = {
    job: originator,
    service: originator,
    exporter: 'notify',
    level: 'INFO',
    hostname,
    source: 'codex-notify',
    ...(extraLabels ?? {}),
  }

  const values: [string, string][] = [[nowNs.toString(), JSON.stringify(event)]]
  const streams: LokiStream[] = [{ stream: labels, values }]
  return streams
}

const main = async () => {
  const raw = await parsePayload()
  if (!raw) {
    console.error('Missing notify payload JSON')
    process.exit(1)
  }

  let payload: NotifyPayload
  try {
    payload = JSON.parse(raw) as NotifyPayload
  } catch (error) {
    console.error('Failed to parse notify payload JSON:', error)
    process.exit(1)
    return
  }

  const url = process.env.CODEX_NOTIFY_LOKI_URL || 'http://loki/loki/api/v1/push'
  const streams = buildStreams(payload)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (process.env.CODEX_NOTIFY_LOKI_AUTH_HEADER) {
    headers.Authorization = process.env.CODEX_NOTIFY_LOKI_AUTH_HEADER
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ streams }),
  })

  if (!response.ok) {
    const body = await response.text()
    console.error(`Loki push failed (${response.status} ${response.statusText}): ${body}`)
    process.exit(1)
  }
}

if (import.meta.main) {
  await main()
}
