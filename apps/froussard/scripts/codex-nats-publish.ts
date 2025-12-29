#!/usr/bin/env bun
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { Readable } from 'node:stream'
import { createInterface } from 'node:readline'

type Options = {
  kind: string
  content?: string
  logFile?: string
  channel: string
  publishGeneral: boolean
  status?: string
  exitCode?: string
}

const usage = () => {
  process.stdout.write(`Usage: codex-nats-publish --kind <status|log> [options]

Options:
  --kind <value>        Required kind for the event.
  --content <text>      Publish a single event with the provided content.
  --log-file <path>     Tail a log file and publish each line as an event.
  --channel <value>     Channel name for run-specific events (default: run).
  --publish-general     Also publish each event to argo.workflow.general.<kind>.
  --status <value>      Optional status value for status events.
  --exit-code <value>   Optional exit code for status events.
  -h, --help            Show this help text.

Environment:
  NATS_URL              NATS server URL.
  NATS_CREDS            Optional credentials content.
  NATS_CREDS_FILE       Optional credentials file path.
  NATS_SUBJECT_PREFIX   Subject prefix (default: argo.workflow).
  WORKFLOW_NAME         Argo workflow name.
  WORKFLOW_UID          Argo workflow uid.
  WORKFLOW_NAMESPACE    Argo workflow namespace.
  WORKFLOW_STAGE        Optional workflow stage.
  WORKFLOW_STEP         Optional workflow step (e.g. pod name).
  AGENT_ID              Agent identifier.
  AGENT_ROLE            Optional agent role (defaults to assistant).
  RUN_ID                Optional Codex run id for Jangar correlation.
`)
}

const coerceNonEmpty = (value?: string | null) => {
  if (!value) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const parseArgs = (argv: string[]): Options | null => {
  const options: Options = {
    kind: '',
    channel: 'run',
    publishGeneral: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--kind':
        options.kind = argv[i + 1] ?? ''
        i += 1
        break
      case '--content':
        options.content = argv[i + 1]
        i += 1
        break
      case '--log-file':
        options.logFile = argv[i + 1]
        i += 1
        break
      case '--channel':
        options.channel = argv[i + 1] ?? 'run'
        i += 1
        break
      case '--publish-general':
        options.publishGeneral = true
        break
      case '--status':
        options.status = argv[i + 1]
        i += 1
        break
      case '--exit-code':
        options.exitCode = argv[i + 1]
        i += 1
        break
      case '-h':
      case '--help':
        usage()
        return null
      default:
        process.stderr.write(`Unknown argument: ${arg}\n`)
        usage()
        process.exit(1)
    }
  }

  if (!options.kind.trim()) {
    process.stderr.write('Missing required --kind\n')
    usage()
    process.exit(1)
  }

  return options
}

const buildPayload = (
  options: Options,
  content: string,
  context: {
    workflowNamespace: string
    workflowName: string
    workflowUid: string
    workflowStage: string | null
    workflowStep: string | null
    agentId: string
    agentRole: string
    runId: string | null
  },
  channel: string,
  messageId: string,
  sentAt: string,
) => {
  const payload: Record<string, unknown> = {
    message_id: messageId,
    sent_at: sentAt,
    timestamp: sentAt,
    kind: options.kind,
    workflow_uid: context.workflowUid,
    workflow_name: context.workflowName,
    workflow_namespace: context.workflowNamespace,
    agent_id: context.agentId,
    role: context.agentRole,
    channel,
    content,
  }

  if (context.runId) payload.run_id = context.runId
  if (context.workflowStep) payload.step_id = context.workflowStep
  if (context.workflowStage) payload.stage = context.workflowStage
  if (context.workflowStage) payload.workflow_stage = context.workflowStage
  if (context.workflowStep) payload.workflow_step = context.workflowStep
  if (options.status) payload.status = options.status
  if (options.exitCode) {
    const parsed = Number(options.exitCode)
    if (Number.isFinite(parsed)) {
      payload.exit_code = parsed
    }
  }

  return payload
}

const buildNatsArgs = (credsFile: string | null) => {
  const args = ['pub']
  const server = process.env.NATS_URL?.trim()
  if (server) {
    args.push('--server', server)
  }

  if (credsFile) {
    args.push('--creds', credsFile)
  } else {
    const user = process.env.NATS_USER?.trim()
    const pass = process.env.NATS_PASSWORD?.trim()
    if (user) {
      args.push('--user', user)
      if (pass) args.push('--password', pass)
    }
  }

  args.push('-H', 'content-type: application/json')
  return args
}

const resolveCredsFile = () => {
  const envFile = process.env.NATS_CREDS_FILE?.trim()
  if (envFile) return { path: envFile, cleanup: () => {} }

  const creds = process.env.NATS_CREDS
  if (!creds) return { path: null, cleanup: () => {} }

  const filePath = resolve(tmpdir(), `nats-creds-${crypto.randomUUID()}.creds`)
  writeFileSync(filePath, creds, 'utf8')
  return {
    path: filePath,
    cleanup: () => {
      try {
        unlinkSync(filePath)
      } catch {
        // ignore cleanup failures
      }
    },
  }
}

const publishPayload = async (subject: string, payload: Record<string, unknown>, natsArgs: string[]) => {
  const message = JSON.stringify(payload)
  const spawn = Bun.spawn(['nats', ...natsArgs, subject, message], {
    stdout: 'ignore',
    stderr: 'inherit',
  })
  const exitCode = await spawn.exited
  if (exitCode !== 0) {
    process.stderr.write(`Failed to publish to ${subject}\n`)
  }
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  if (!options) return

  const natsUrl = process.env.NATS_URL?.trim()
  if (!natsUrl) return

  const natsPath = Bun.which('nats')
  if (!natsPath) {
    process.stderr.write('nats CLI not found; skipping publish\n')
    return
  }

  const workflowNamespace = process.env.WORKFLOW_NAMESPACE?.trim() || 'argo-workflows'
  const workflowName = process.env.WORKFLOW_NAME?.trim() || 'unknown'
  const workflowUid = process.env.WORKFLOW_UID?.trim() || 'unknown'
  const workflowStage = coerceNonEmpty(process.env.WORKFLOW_STAGE)
  const workflowStep = coerceNonEmpty(process.env.WORKFLOW_STEP ?? process.env.STEP_ID)
  const agentId = process.env.AGENT_ID?.trim() || 'unknown'
  const agentRole = coerceNonEmpty(process.env.AGENT_ROLE) ?? 'assistant'
  const runId =
    coerceNonEmpty(process.env.RUN_ID) ??
    coerceNonEmpty(process.env.CODEX_RUN_ID) ??
    coerceNonEmpty(process.env.JANGAR_RUN_ID)
  const subjectPrefix = process.env.NATS_SUBJECT_PREFIX?.trim() || 'argo.workflow'

  const creds = resolveCredsFile()
  const natsArgs = buildNatsArgs(creds.path)

  const runSubject = `${subjectPrefix}.${workflowNamespace}.${workflowName}.${workflowUid}.agent.${agentId}.${options.kind}`
  const generalSubject = `${subjectPrefix}.general.${options.kind}`

  const context = {
    workflowNamespace,
    workflowName,
    workflowUid,
    workflowStage,
    workflowStep,
    agentId,
    agentRole,
    runId,
  }

  const publishLine = async (line: string) => {
    const content = line.trim()
    if (!content) return
    const messageId = crypto.randomUUID()
    const sentAt = new Date().toISOString()
    const payload = buildPayload(options, content, context, options.channel, messageId, sentAt)
    await publishPayload(runSubject, payload, natsArgs)
    if (options.publishGeneral) {
      const generalPayload = buildPayload(options, content, context, 'general', messageId, sentAt)
      await publishPayload(generalSubject, generalPayload, natsArgs)
    }
  }

  try {
    if (options.logFile) {
      const tail = Bun.spawn(['tail', '-n', '+1', '-F', options.logFile], {
        stdout: 'pipe',
        stderr: 'inherit',
      })
      const readable = tail.stdout ? Readable.fromWeb(tail.stdout) : null
      if (!readable) return
      const rl = createInterface({ input: readable })
      for await (const line of rl) {
        await publishLine(line)
      }
      return
    }

    if (options.content) {
      await publishLine(options.content)
      return
    }

    const rl = createInterface({ input: process.stdin })
    for await (const line of rl) {
      await publishLine(line)
    }
  } finally {
    creds.cleanup()
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
