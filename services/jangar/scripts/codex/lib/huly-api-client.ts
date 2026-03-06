import { spawn as spawnChild } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

type RunHulyApiArgs = {
  operation: string
  args: string[]
}

type MessageEntry = {
  messageId?: string | null
  message?: string | null
  createdBy?: string | null
  modifiedOn?: string | number | null
}

export type HulyChannelMessage = {
  action?: string
  channelId?: string
  channelName?: string
  messageId?: string
  replyToMessageId?: string | null
  replyToMessageClass?: string
  collection?: string
}

export type HulyListChannelMessagesResult = {
  channelId?: string
  channelName?: string
  count?: number
  messages?: MessageEntry[]
}

export type HulyVerifyChatAccessResult = {
  workspaceId?: string
  actorId?: string
  expectedActorId?: string
  tokenSource?: string
  workerScopedToken?: boolean
  channelMessage?: HulyChannelMessage
  message?: string
}

export type HulyPostChannelMessageResult = {
  action?: string
  channelId?: string
  channelName?: string
  messageId?: string
  replyToMessageId?: string | null
  replyToMessageClass?: string
  collection?: string
}

export type HulyUpsertMissionResult = {
  missionId?: string
  stage?: string
  status?: string
  issue?: {
    issueId?: string
    issueTitle?: string
    issueIdentifier?: string | null
    issueNumber?: number
    projectIdentifier?: string
    projectId?: string
  }
  document?: {
    documentId?: string
    documentTitle?: string
    teamspaceId?: string
  }
  channelMessage?: HulyChannelMessage
  apiBaseUrl?: string
  workspaceId?: string
}

type HulyArtifactOperationResult =
  | HulyListChannelMessagesResult
  | HulyVerifyChatAccessResult
  | HulyPostChannelMessageResult
  | HulyUpsertMissionResult

const DEFAULT_HULY_API_PATH = fileURLToPath(
  new URL('../../../../../skills/huly-api/scripts/huly-api.py', import.meta.url),
)
const DEFAULT_PYTHON_BIN = 'python3'

const runProcess = async (command: string, args: string[]): Promise<CommandResult> => {
  return await new Promise<CommandResult>((resolve, reject) => {
    const proc = spawnChild(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    proc.on('error', reject)
    proc.on('close', (code) => {
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
      })
    })
  })
}

const parseJson = <T extends object>(value: string): T => {
  try {
    return JSON.parse(value) as T
  } catch {
    throw new Error('Failed to parse huly-api JSON output')
  }
}

const runHulyApi = async <T extends object>(payload: RunHulyApiArgs): Promise<T & HulyArtifactOperationResult> => {
  const command = resolvePythonPath()
  const scriptPath = resolveHulyApiScriptPath()
  const result = await runProcess(command, [scriptPath, '--operation', payload.operation, ...payload.args])
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim() || 'unknown error'
    const stdout = result.stdout.trim()
    throw new Error(
      `huly-api ${payload.operation} failed with code ${result.exitCode}` +
        (stdout ? `: ${stdout}` : '') +
        (stderr ? `: ${stderr}` : ''),
    )
  }

  const trimmed = result.stdout.trim()
  if (!trimmed) {
    throw new Error(`huly-api ${payload.operation} produced no parseable output`)
  }

  return parseJson<T>(trimmed)
}

const withWorkerAuthArgs = ({
  workerId,
  workerIdentity,
  requireWorkerToken,
  tokenEnvKey,
  expectedActorEnvKey,
  requireExpectedActorId,
}: {
  workerId?: string
  workerIdentity?: string
  requireWorkerToken: boolean
  tokenEnvKey?: string
  expectedActorEnvKey?: string
  requireExpectedActorId?: boolean
}) => {
  const args: string[] = []
  if (requireWorkerToken) {
    args.push('--require-worker-token')
  }
  if (requireExpectedActorId) {
    args.push('--require-expected-actor-id')
  }
  if (workerId) {
    args.push('--worker-id', workerId)
  }
  if (workerIdentity) {
    args.push('--worker-identity', workerIdentity)
  }
  if (tokenEnvKey) {
    args.push('--token-env-key', tokenEnvKey)
  }
  if (expectedActorEnvKey) {
    args.push('--expected-actor-env-key', expectedActorEnvKey)
  }
  return args
}

export const listChannelMessages = async ({
  channel,
  workerId,
  workerIdentity,
  limit = 30,
  requireWorkerToken = true,
  tokenEnvKey,
  expectedActorEnvKey,
  requireExpectedActorId = false,
}: {
  channel: string
  workerId?: string
  workerIdentity?: string
  limit?: number
  requireWorkerToken?: boolean
  tokenEnvKey?: string
  expectedActorEnvKey?: string
  requireExpectedActorId?: boolean
}) => {
  const result = await runHulyApi<HulyListChannelMessagesResult>({
    operation: 'list-channel-messages',
    args: [
      ...withWorkerAuthArgs({
        workerId,
        workerIdentity,
        requireWorkerToken,
        tokenEnvKey,
        expectedActorEnvKey,
        requireExpectedActorId,
      }),
      '--channel',
      channel,
      '--limit',
      String(limit),
    ],
  })
  return result
}

export const verifyChatAccess = async ({
  channel,
  message,
  workerId,
  workerIdentity,
  requireWorkerToken = true,
  tokenEnvKey,
  expectedActorEnvKey,
  requireExpectedActorId = false,
}: {
  channel: string
  message: string
  workerId?: string
  workerIdentity?: string
  requireWorkerToken?: boolean
  tokenEnvKey?: string
  expectedActorEnvKey?: string
  requireExpectedActorId?: boolean
}) => {
  const result = await runHulyApi<HulyVerifyChatAccessResult>({
    operation: 'verify-chat-access',
    args: [
      ...withWorkerAuthArgs({
        workerId,
        workerIdentity,
        requireWorkerToken,
        tokenEnvKey,
        expectedActorEnvKey,
        requireExpectedActorId,
      }),
      '--channel',
      channel,
      '--message',
      message,
    ],
  })
  return result
}

export const postChannelMessage = async ({
  channel,
  message,
  replyToMessageId,
  replyToMessageClass,
  workerId,
  workerIdentity,
  requireWorkerToken = true,
  tokenEnvKey,
  expectedActorEnvKey,
  requireExpectedActorId = false,
}: {
  channel: string
  message: string
  replyToMessageId?: string
  replyToMessageClass?: string
  workerId?: string
  workerIdentity?: string
  requireWorkerToken?: boolean
  tokenEnvKey?: string
  expectedActorEnvKey?: string
  requireExpectedActorId?: boolean
}) => {
  const args = [
    ...withWorkerAuthArgs({
      workerId,
      workerIdentity,
      requireWorkerToken,
      tokenEnvKey,
      expectedActorEnvKey,
      requireExpectedActorId,
    }),
    '--channel',
    channel,
    '--message',
    message,
  ]
  if (replyToMessageId) {
    args.push('--reply-to-message-id', replyToMessageId)
  }
  if (replyToMessageClass) {
    args.push('--reply-to-message-class', replyToMessageClass)
  }

  const result = await runHulyApi<HulyPostChannelMessageResult>({
    operation: 'post-channel-message',
    args,
  })
  return result
}

export const upsertMission = async ({
  missionId,
  title,
  summary,
  details,
  channel,
  message,
  stage = 'implementation',
  status = 'completed',
  workerId,
  workerIdentity,
  requireWorkerToken = true,
  tokenEnvKey,
  expectedActorEnvKey,
  requireExpectedActorId = false,
}: {
  missionId: string
  title: string
  summary: string
  details?: string
  channel: string
  message: string
  stage?: string
  status?: string
  workerId?: string
  workerIdentity?: string
  requireWorkerToken?: boolean
  tokenEnvKey?: string
  expectedActorEnvKey?: string
  requireExpectedActorId?: boolean
}) => {
  const args = [
    ...withWorkerAuthArgs({
      workerId,
      workerIdentity,
      requireWorkerToken,
      tokenEnvKey,
      expectedActorEnvKey,
      requireExpectedActorId,
    }),
    '--mission-id',
    missionId,
    '--title',
    title,
    '--summary',
    summary,
    '--stage',
    stage,
    '--status',
    status,
    '--channel',
    channel,
    '--message',
    message,
  ]

  if (details) {
    args.push('--details', details)
  }

  const result = await runHulyApi<HulyUpsertMissionResult>({
    operation: 'upsert-mission',
    args,
  })
  return result
}

export const resolveHulyApiScriptPath = () => {
  const configured = process.env.HULY_API_SCRIPT_PATH?.trim()
  return configured && configured.length > 0 ? configured : DEFAULT_HULY_API_PATH
}

export const resolvePythonPath = () => {
  return process.env.PYTHON_BIN || process.env.PYTHON || DEFAULT_PYTHON_BIN
}
