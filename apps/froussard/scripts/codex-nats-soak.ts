#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

type Options = {
  stream: string
  subject: string
  count: number
  outputPath?: string
}

type NatsMessage = {
  message_id?: string
  sent_at?: string
  timestamp?: string
  kind?: string
  channel?: string
  content?: string
  attrs?: Record<string, unknown>
  repository?: string
  issueNumber?: number | string
  branch?: string
  workflow_uid?: string
  workflow_name?: string
  workflow_namespace?: string
  stage?: string
  agent_id?: string
}

type NatsContextResult = {
  stream: string
  subject: string
  count: number
  fetched: number
  filtered: number
  messages: NatsMessage[]
}

const coerceNonEmpty = (value?: string | null) => {
  if (!value) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const parseNumber = (value: string | undefined, fallback: number) => {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const resolveCredsFile = () => {
  const explicitPath = coerceNonEmpty(process.env.NATS_CREDS_FILE)
  if (explicitPath) return { path: explicitPath, cleanup: () => {} }

  const creds = coerceNonEmpty(process.env.NATS_CREDS)
  if (!creds) return { path: null as string | null, cleanup: () => {} }

  const filePath = resolve(tmpdir(), `nats-creds-${Date.now()}.txt`)
  writeFileSync(filePath, creds, 'utf8')
  return {
    path: filePath,
    cleanup: () => {
      try {
        unlinkSync(filePath)
      } catch {
        // ignore cleanup errors
      }
    },
  }
}

const buildNatsArgs = (credsFile: string | null) => {
  const args = [] as string[]
  const server = coerceNonEmpty(process.env.NATS_URL)
  if (server) {
    args.push('--server', server)
  }
  if (credsFile) {
    args.push('--creds', credsFile)
  } else {
    const user = coerceNonEmpty(process.env.NATS_USER)
    const pass = coerceNonEmpty(process.env.NATS_PASSWORD)
    if (user) {
      args.push('--user', user)
    }
    if (pass) {
      args.push('--password', pass)
    }
  }
  return args
}

const parseMessages = (raw: string): NatsMessage[] => {
  if (!raw.trim()) return []
  const messages: NatsMessage[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as NatsMessage
      messages.push(parsed)
    } catch {
      messages.push({ content: trimmed })
    }
  }
  return messages
}

const normalizeIssueNumber = (value: string | number | null) => {
  if (value == null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

const filterMessages = (
  messages: NatsMessage[],
  filters: { repository?: string; issueNumber?: number | null; branch?: string },
) => {
  return messages.filter((message) => {
    if (filters.repository && message.repository && message.repository !== filters.repository) return false
    if (filters.issueNumber != null) {
      const normalized = normalizeIssueNumber(message.issueNumber ?? null)
      if (normalized != null && normalized !== filters.issueNumber) return false
    }
    if (filters.branch && message.branch && message.branch !== filters.branch) return false
    if (message.channel && message.channel !== 'general') return false
    return true
  })
}

const run = () => {
  const options: Options = {
    stream: coerceNonEmpty(process.env.NATS_STREAM) ?? 'agent-comms',
    subject: coerceNonEmpty(process.env.NATS_CONTEXT_SUBJECT) ?? 'argo.workflow.general.message',
    count: parseNumber(process.env.NATS_CONTEXT_COUNT, 50),
    outputPath: coerceNonEmpty(process.env.NATS_CONTEXT_PATH) ?? undefined,
  }

  if (!coerceNonEmpty(process.env.NATS_URL)) {
    throw new Error('NATS_URL is required for context soak')
  }

  const creds = resolveCredsFile()
  try {
    const args = [
      'stream',
      'view',
      options.stream,
      '--subject',
      options.subject,
      '--count',
      String(options.count),
      '--raw',
    ]
    const command = spawnSync('nats', [...buildNatsArgs(creds.path), ...args], {
      encoding: 'utf8',
    })

    if (command.status !== 0) {
      const stderr = command.stderr?.trim() || command.stdout?.trim()
      throw new Error(stderr || 'nats stream view failed')
    }

    const messages = parseMessages(command.stdout ?? '')
    const filtered = filterMessages(messages, {
      repository: coerceNonEmpty(process.env.CODEX_REPOSITORY) ?? coerceNonEmpty(process.env.ISSUE_REPO) ?? undefined,
      issueNumber: normalizeIssueNumber(coerceNonEmpty(process.env.CODEX_ISSUE_NUMBER)),
      branch: coerceNonEmpty(process.env.CODEX_BRANCH) ?? undefined,
    })

    const result: NatsContextResult = {
      stream: options.stream,
      subject: options.subject,
      count: options.count,
      fetched: messages.length,
      filtered: filtered.length,
      messages: filtered,
    }

    const payload = JSON.stringify(result, null, 2)
    if (options.outputPath) {
      writeFileSync(options.outputPath, payload, 'utf8')
    } else {
      process.stdout.write(payload)
    }
  } finally {
    creds.cleanup()
  }
}

try {
  run()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
