#!/usr/bin/env bun
import { spawn as spawnChild } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { Effect } from 'effect'

import { runCli } from './lib/cli'
import { pushCodexEventsToLoki, type RunCodexSessionResult, runCodexSession } from './lib/codex-runner'
import {
  listChannelMessages,
  postChannelMessage,
  type HulyListChannelMessagesResult,
  type HulyPostChannelMessageResult,
  type HulyUpsertMissionResult,
  type HulyVerifyChatAccessResult,
  upsertMission,
  verifyChatAccess,
} from './lib/huly-api-client'
import {
  buildDiscordChannelCommand,
  copyAgentLogIfNeeded,
  parseBoolean,
  pathExists,
  randomRunId,
  timestampUtc,
} from './lib/codex-utils'
import { ensureFileDirectory } from './lib/fs'
import { type CodexLogger, consoleLogger, createCodexLogger } from './lib/logger'
import { evaluatePullRequestPolicy } from './lib/pull-request-policy'
import { runCodexProgressComment } from './codex-progress-comment'

const GOVERNING_DESIGN_DOCUMENTS = [
  'docs/agents/designs/autonomous-jangar-torghut-production-system.md',
  'docs/agents/swarm-end-to-end-runbook.md',
]
const GOVERNING_DESIGN_DOCUMENT = GOVERNING_DESIGN_DOCUMENTS.join(' | ')
const MAX_REQUIREMENT_DESCRIPTION_PROMPT_CHARS = 4000
const MAX_REQUIREMENT_PAYLOAD_PROMPT_CHARS = 6000
const MAX_BASE_PROMPT_CONTEXT_CHARS = 10000
const DEFAULT_MAX_PROMPT_CHARS = 26000

type SwarmRequirementPayloadMetadata = {
  objective?: string
  acceptance?: string[]
}

interface ImplementationEventPayload {
  prompt?: string
  systemPrompt?: string | null
  repository?: string
  issueNumber?: number | string
  objective?: string
  swarmRequirementObjective?: string
  issueTitle?: string | null
  issueBody?: string | null
  issueUrl?: string | null
  stage?: string | null
  base?: string | null
  head?: string | null
  planCommentId?: number | string | null
  planCommentUrl?: string | null
  planCommentBody?: string | null
  iteration?: number | string | null
  iterationCycle?: number | string | null
  iteration_cycle?: number | string | null
  iterations?: number | string | null
  parameters?: Record<string, string | number | boolean>
  swarmRequirementId?: string | null
  swarmRequirementSignal?: string | null
  swarmRequirementSource?: string | null
  swarmRequirementTarget?: string | null
  swarmRequirementChannel?: string | null
  swarmRequirementDescription?: string | null
  swarmRequirementPayload?: string | null
  swarmRequirementPayloadBytes?: string | number | null
  swarmRequirementPayloadTruncated?: string | boolean | null
  swarmAgentWorkerId?: string | null
  swarmAgentIdentity?: string | null
  swarmAgentRole?: string | null
  swarmHumanName?: string | null
}

const readEventPayload = async (path: string): Promise<ImplementationEventPayload> => {
  const raw = await readFile(path, 'utf8')
  try {
    return JSON.parse(raw) as ImplementationEventPayload
  } catch (error) {
    throw new Error(
      `Failed to parse event payload at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

type RequirementMetadata = {
  id?: string
  signal?: string
  source?: string
  target?: string
  channel?: string
  description?: string
  objective?: string
  swarmRequirementObjective?: string
  payload?: string
  payloadBytes?: string
  payloadTruncated?: boolean
  acceptance?: string[]
  workerId?: string
  workerIdentity?: string
  workerRole?: string
  workerHumanName?: string
}

type HulyRequirementArtifacts = {
  activeChannel: string
  actorId?: string
  latestPeerMessageId?: string
  latestPeerMessage?: string
  verification?: HulyVerifyChatAccessResult
  listMessages?: HulyListChannelMessagesResult
  replyMessage?: HulyPostChannelMessageResult
  ownerMessage?: HulyPostChannelMessageResult
  mission?: HulyUpsertMissionResult
}

type HulyArtifactsForNotify = {
  channel?: string
  actorId?: string
  latestPeerMessageId?: string
  replyMessageId?: string
  ownerMessageId?: string
  missionId?: string
  missionStatus?: string
  missionStage?: string
  missionIssue?: string
}

const asStringMap = (value: Record<string, string | number | boolean> | undefined): Record<string, string> => {
  if (!value) {
    return {}
  }
  const output: Record<string, string> = {}
  for (const [key, rawValue] of Object.entries(value)) {
    if (typeof rawValue === 'string') {
      output[key] = rawValue
    } else if (typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      output[key] = String(rawValue)
    }
  }
  return output
}

const normalizeNullableStringValue = (value: string | null | undefined | number | boolean) => {
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const parseBool = (value: string | boolean | number | null | undefined) => {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return value !== 0
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true
    }
    if (['0', 'false', 'no', 'off', ''].includes(normalized)) {
      return false
    }
  }
  return false
}

const normalizeRoleLabel = (value: string | null | undefined) =>
  (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')

const isReleaseManagerLikeExecution = (requirementMetadata: RequirementMetadata) => {
  const role = normalizeRoleLabel(requirementMetadata.workerRole)
  const humanName = normalizeRoleLabel(requirementMetadata.workerHumanName)
  return role === 'deployer' || role === 'release-manager' || humanName === 'release-manager'
}

type SwarmExecutionLane = 'architect' | 'engineer' | 'release'

const ARCHITECT_ROLE_LABELS = new Set(['architector', 'architect'])
const RELEASE_ROLE_LABELS = new Set(['deployer', 'release-manager', 'release'])
const ENGINEER_ROLE_LABELS = new Set(['engineer', 'implement'])

const resolveExecutionLane = ({
  stage,
  requirementMetadata,
}: {
  stage: string
  requirementMetadata: RequirementMetadata
}): SwarmExecutionLane => {
  const role = normalizeRoleLabel(requirementMetadata.workerRole)
  const humanName = normalizeRoleLabel(requirementMetadata.workerHumanName)
  if (ARCHITECT_ROLE_LABELS.has(role) || ARCHITECT_ROLE_LABELS.has(humanName)) {
    return 'architect'
  }
  if (RELEASE_ROLE_LABELS.has(role) || RELEASE_ROLE_LABELS.has(humanName)) {
    return 'release'
  }
  if (ENGINEER_ROLE_LABELS.has(role) || ENGINEER_ROLE_LABELS.has(humanName)) {
    return 'engineer'
  }
  if (stage === 'planning' || stage === 'research') {
    return 'architect'
  }
  if (stage === 'verify' || stage === 'review') {
    return 'release'
  }
  return 'engineer'
}

const isHulyRequirementChannel = (channel: string | undefined | null) => {
  if (!channel) {
    return false
  }
  const normalized = channel.trim()
  const lower = normalized.toLowerCase()
  if (lower.startsWith('huly://')) {
    return true
  }
  try {
    const parsed = new URL(normalized)
    return parsed.protocol.startsWith('http') && parsed.hostname.toLowerCase().includes('huly')
  } catch {
    return false
  }
}

const resolveHulyChannelFromCandidate = (value: string | null | undefined) => {
  const normalized = normalizeNullableStringValue(value)
  if (normalized && isHulyRequirementChannel(normalized)) {
    return normalized
  }
  return undefined
}

const resolveActiveHulyChannel = (requirementMetadata: RequirementMetadata) => {
  const candidates = [
    requirementMetadata.channel,
    process.env.hulyChannelName,
    process.env.HULY_CHANNEL_NAME,
    process.env.hulyChannelUrl,
    process.env.HULY_CHANNEL_URL,
  ]

  return candidates
    .map((candidate) => resolveHulyChannelFromCandidate(candidate))
    .find((candidate): candidate is string => candidate !== undefined)
}

const summarizeText = (value: string | undefined, max = 260) => {
  if (!value) {
    return ''
  }
  const trimmed = value.trim()
  if (trimmed.length <= max) {
    return trimmed
  }
  return `${trimmed.slice(0, max)}…`
}

const truncatePromptSegment = (value: string, maxChars: number) => {
  const normalized = value.trim()
  if (normalized.length <= maxChars) {
    return normalized
  }
  return `${normalized.slice(0, maxChars)}\n...[truncated ${normalized.length - maxChars} chars]`
}

const resolveLatestPeerMessage = (
  payload: HulyListChannelMessagesResult | undefined,
  actorId?: string,
): { messageId: string; message: string } | undefined => {
  const messages = payload?.messages
  if (!messages || messages.length === 0) {
    return undefined
  }

  for (const message of messages) {
    const messageId = normalizeNullableStringValue(message.messageId)
    const text = normalizeNullableStringValue(message.message)
    if (!messageId || !text) {
      continue
    }
    if (actorId && typeof message.createdBy === 'string' && message.createdBy === actorId) {
      continue
    }
    return { messageId, message: text }
  }

  const fallback = messages.find((entry) => {
    const messageId = normalizeNullableStringValue(entry.messageId)
    const message = normalizeNullableStringValue(entry.message)
    return Boolean(messageId && message)
  })

  if (!fallback?.messageId || !fallback?.message) {
    return undefined
  }

  return { messageId: String(fallback.messageId), message: String(fallback.message) }
}

const buildHulyReplyMessage = ({
  message,
  objective,
  decision,
  issueNumber,
  stage,
  prUrl,
  tests,
  gaps,
}: {
  message: string
  objective?: string
  decision: 'completed' | 'failed'
  issueNumber: string
  stage: string
  prUrl?: string | null
  tests?: string[]
  gaps?: string[]
}) => {
  const lines = [
    `Thanks for the note: "${summarizeText(message, 100)}".`,
    decision === 'completed'
      ? `Update for #${issueNumber}: ${stage} is complete.`
      : `Update for #${issueNumber}: ${stage} is currently blocked.`,
    objective ? `I kept the work focused on ${summarizeText(objective, 160)}.` : '',
    prUrl ? `PR: ${prUrl}.` : '',
    tests && tests.length > 0 ? `Validation: ${tests.join(', ')}.` : '',
    gaps && gaps.length > 0 ? `Current risk: ${gaps.join('; ')}.` : '',
  ]

  return lines.filter((line) => line.length > 0).join(' ')
}

const buildOwnerUpdateMessage = ({
  decision,
  issueNumber,
  repository,
  requirementMetadata,
  runSummary,
  tests,
  prUrl,
  stage,
  gaps,
}: {
  decision: 'completed' | 'failed'
  repository: string
  issueNumber: string
  stage: string
  requirementMetadata: RequirementMetadata
  runSummary?: string | null
  tests?: string[]
  gaps?: string[]
  prUrl?: string | null
}) => {
  const ownerStatus = decision === 'completed' ? 'completed' : 'blocked pending follow-up'
  const lines = [
    `Update on ${repository}#${issueNumber}: ${stage} is ${ownerStatus}.`,
    requirementMetadata.objective ? `Objective: ${summarizeText(requirementMetadata.objective, 200)}.` : '',
    runSummary ? `Summary: ${summarizeText(runSummary, 220)}.` : '',
    prUrl ? `PR: ${prUrl}.` : '',
    tests && tests.length > 0
      ? `Validation results: ${tests.join('; ')}.`
      : 'Validation results: no explicit test list in the final run output.',
    gaps && gaps.length > 0 ? `Key risks: ${gaps.join('; ')}.` : 'Key risks: none identified.',
    requirementMetadata.acceptance && requirementMetadata.acceptance.length > 0
      ? `Acceptance criteria: ${requirementMetadata.acceptance.join('; ')}.`
      : '',
    decision === 'completed'
      ? 'Next step: deployer rollout verification in cluster.'
      : 'Next step: address blocker, rerun implementation, then re-verify rollout.',
  ]

  return lines.filter((line) => line.length > 0).join(' ')
}

const buildMissionDetails = ({
  requirementMetadata,
  repository,
  issueNumber,
  prUrl,
  tests,
  gaps,
  summary,
}: {
  repository: string
  issueNumber: string
  requirementMetadata: RequirementMetadata
  prUrl?: string | null
  tests?: string[]
  gaps?: string[]
  summary?: string | null
}) => {
  const details = [
    `- Repository: ${repository}`,
    `- Issue: #${issueNumber}`,
    `- Design document: ${GOVERNING_DESIGN_DOCUMENT}`,
  ]

  if (requirementMetadata.id) {
    details.push(`- Requirement ID: ${requirementMetadata.id}`)
  }
  if (requirementMetadata.signal) {
    details.push(`- Signal: ${requirementMetadata.signal}`)
  }
  if (requirementMetadata.source) {
    details.push(`- Source: ${requirementMetadata.source}`)
  }
  if (requirementMetadata.target) {
    details.push(`- Target: ${requirementMetadata.target}`)
  }

  if (summary) {
    details.push(`- Summary: ${summarizeText(summary, 360)}`)
  }

  if (prUrl) {
    details.push(`- PR: ${prUrl}`)
  }

  if (tests && tests.length > 0) {
    details.push(`- Tests: ${tests.join(', ')}`)
  }

  if (gaps && gaps.length > 0) {
    details.push(`- Risks/Gaps: ${gaps.join('; ')}`)
  }

  if (requirementMetadata.acceptance && requirementMetadata.acceptance.length > 0) {
    details.push(`- Acceptance criteria: ${requirementMetadata.acceptance.join('; ')}`)
  }

  return details.join('\n')
}

const resolveHulyMissionTitle = ({
  repository,
  issueNumber,
  requirementMetadata,
}: {
  repository: string
  issueNumber: string
  requirementMetadata: RequirementMetadata
}) => {
  if (requirementMetadata.id) {
    return `Cross-swarm mission ${requirementMetadata.id} (${repository}#${issueNumber})`
  }
  return `Cross-swarm mission ${repository}#${issueNumber}`
}

const resolveHulyMissionId = ({
  repository,
  issueNumber,
  requirementMetadata,
}: {
  repository: string
  issueNumber: string
  requirementMetadata: RequirementMetadata
}) => {
  if (requirementMetadata.id) {
    return requirementMetadata.id
  }
  return `${repository}-issue-${issueNumber}`
}

const resolveHulyWorkerContext = (requirementMetadata: RequirementMetadata) => ({
  workerId: requirementMetadata.workerId,
  workerIdentity: requirementMetadata.workerIdentity,
})

const collectHulyArtifactsForNotify = (artifacts?: HulyRequirementArtifacts): HulyArtifactsForNotify | undefined => {
  if (!artifacts) {
    return undefined
  }
  return {
    channel: artifacts.activeChannel,
    actorId: artifacts.actorId,
    latestPeerMessageId: artifacts.latestPeerMessageId,
    replyMessageId: artifacts.replyMessage?.messageId,
    ownerMessageId: artifacts.ownerMessage?.messageId,
    missionId: artifacts.mission?.missionId,
    missionStatus: artifacts.mission?.status,
    missionStage: artifacts.mission?.stage,
    missionIssue: artifacts.mission?.issue?.issueIdentifier,
  }
}

const buildHulyArtifactsFromRun = async ({
  artifacts,
  logger,
  repository,
  issueNumber,
  requirementMetadata,
  stage,
  tests,
  gaps,
  prUrl,
  decision,
  runSummary,
  activeChannel,
  workerContext,
  includeReplyMessage,
  latestPeerMessageId,
  latestPeerMessage,
}: {
  artifacts: HulyRequirementArtifacts
  logger: CodexLogger
  repository: string
  issueNumber: string
  requirementMetadata: RequirementMetadata
  stage: string
  tests?: string[]
  gaps?: string[]
  prUrl?: string | null
  decision: 'completed' | 'failed'
  runSummary?: string | null
  activeChannel: string
  workerContext: ReturnType<typeof resolveHulyWorkerContext>
  includeReplyMessage: boolean
  latestPeerMessageId?: string
  latestPeerMessage?: string
}): Promise<HulyRequirementArtifacts> => {
  const decisionSuffix = decision === 'completed' ? 'implementation completed' : 'implementation failed'
  const details = buildMissionDetails({
    repository,
    issueNumber,
    requirementMetadata,
    prUrl,
    tests,
    gaps,
    summary: runSummary,
  })

  if (includeReplyMessage && latestPeerMessageId && latestPeerMessage) {
    const replyMessage = buildHulyReplyMessage({
      message: latestPeerMessage,
      objective: requirementMetadata.objective,
      decision,
      issueNumber,
      stage,
      prUrl,
      tests,
      gaps,
    })
    try {
      artifacts.replyMessage = await postChannelMessage({
        channel: activeChannel,
        message: replyMessage,
        replyToMessageId: latestPeerMessageId,
        workerId: workerContext.workerId,
        workerIdentity: workerContext.workerIdentity,
      })
    } catch (error) {
      logger.warn('Failed to post Huly reply message for requirement handoff', error)
      throw error
    }
  }

  const ownerUpdateMessage = buildOwnerUpdateMessage({
    decision,
    repository,
    issueNumber,
    stage,
    requirementMetadata,
    runSummary,
    tests,
    prUrl,
    gaps,
  })
  try {
    artifacts.ownerMessage = await postChannelMessage({
      channel: activeChannel,
      message: ownerUpdateMessage,
      workerId: workerContext.workerId,
      workerIdentity: workerContext.workerIdentity,
    })
  } catch (error) {
    logger.warn('Failed to post Huly owner update for requirement handoff', error)
    throw error
  }

  const missionId = resolveHulyMissionId({ repository, issueNumber, requirementMetadata })
  try {
    artifacts.mission = await upsertMission({
      missionId,
      title: resolveHulyMissionTitle({ repository, issueNumber, requirementMetadata }),
      summary: `Cross-swarm handoff ${decisionSuffix} for issue ${repository}#${issueNumber}`,
      details,
      channel: activeChannel,
      message: ownerUpdateMessage,
      stage,
      status: decision === 'completed' ? 'completed' : 'failed',
      workerId: workerContext.workerId,
      workerIdentity: workerContext.workerIdentity,
    })
  } catch (error) {
    logger.warn('Failed to upsert Huly mission for requirement handoff', error)
    throw error
  }

  return artifacts
}

const extractSwarmRequirementMetadata = (event: ImplementationEventPayload): RequirementMetadata => {
  const parameters = asStringMap(event.parameters)
  const resolve = (primary: keyof ImplementationEventPayload, fallback?: string) => {
    const primaryValue = normalizeNullableStringValue(event[primary] as string | null | undefined | number | boolean)
    if (primaryValue) {
      return primaryValue
    }
    if (fallback) {
      const fallbackValue = normalizeNullableStringValue(parameters[fallback])
      if (fallbackValue) {
        return fallbackValue
      }
    }
    return undefined
  }

  const payload = resolve('swarmRequirementPayload', 'swarmRequirementPayload')
  const parsedPayload = parseSwarmRequirementPayload(payload)
  const payloadObjective = parsedPayload.objective

  return {
    id: resolve('swarmRequirementId', 'swarmRequirementId'),
    signal: resolve('swarmRequirementSignal', 'swarmRequirementSignal'),
    source: resolve('swarmRequirementSource', 'swarmRequirementSource'),
    target: resolve('swarmRequirementTarget', 'swarmRequirementTarget'),
    channel: resolve('swarmRequirementChannel', 'swarmRequirementChannel'),
    description: resolve('swarmRequirementDescription', 'swarmRequirementDescription'),
    workerId: resolve('swarmAgentWorkerId', 'swarmAgentWorkerId'),
    workerIdentity: resolve('swarmAgentIdentity', 'swarmAgentIdentity'),
    workerRole: resolve('swarmAgentRole', 'swarmAgentRole'),
    workerHumanName: resolve('swarmHumanName', 'swarmHumanName'),
    objective: payloadObjective ?? resolve('objective') ?? resolve('swarmRequirementObjective'),
    payload,
    acceptance: parsedPayload.acceptance,
    payloadBytes: resolve('swarmRequirementPayloadBytes', 'swarmRequirementPayloadBytes'),
    payloadTruncated: parseBool(parameters.swarmRequirementPayloadTruncated),
  }
}

const parseSwarmRequirementPayload = (payload: string | undefined) => {
  const trimmed = payload?.trim()
  if (!trimmed) {
    return {} as SwarmRequirementPayloadMetadata
  }

  try {
    const parsed = JSON.parse(trimmed) as { [key: string]: unknown }
    if (!parsed || typeof parsed !== 'object') {
      return {} as SwarmRequirementPayloadMetadata
    }

    const objective =
      typeof parsed.objective === 'string' && parsed.objective.trim().length > 0 ? parsed.objective.trim() : undefined

    const rawAcceptance =
      typeof parsed.acceptance === 'string'
        ? parsed.acceptance
        : Array.isArray(parsed.acceptance)
          ? parsed.acceptance.join(';')
          : undefined

    const acceptance =
      typeof rawAcceptance === 'string'
        ? rawAcceptance
            .split(';')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)
        : []

    return { objective, acceptance } as SwarmRequirementPayloadMetadata
  } catch {
    return {} as SwarmRequirementPayloadMetadata
  }
}

const prettyRequirementPayload = (payload: string) => {
  const trimmed = payload.trim()
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return trimmed
  }
}

const buildCrossSwarmRequirementScopePrompt = (basePrompt: string, requirement: RequirementMetadata) => {
  if (!isHulyRequirementChannel(requirement.channel)) {
    return basePrompt
  }

  const provenance = [
    requirement.id ? `Requirement ID: ${requirement.id}` : null,
    requirement.signal ? `Signal: ${requirement.signal}` : null,
    requirement.source ? `Source: ${requirement.source}` : null,
    requirement.target ? `Target: ${requirement.target}` : null,
    requirement.channel ? `Channel: ${requirement.channel}` : null,
  ]
    .filter((value): value is string => value !== null)
    .join(' | ')

  const lines = [
    'Cross-swarm implementation requirement (primary scope):',
    provenance.length > 0 ? provenance : 'Cross-swarm requirement received',
  ]

  if (requirement.objective) {
    lines.push(`Objective: ${requirement.objective}`)
  }

  if (requirement.description) {
    lines.push(
      `Description:\n${truncatePromptSegment(requirement.description, MAX_REQUIREMENT_DESCRIPTION_PROMPT_CHARS)}`,
    )
  }

  if (requirement.payload) {
    lines.push(
      `Payload:\n${truncatePromptSegment(prettyRequirementPayload(requirement.payload), MAX_REQUIREMENT_PAYLOAD_PROMPT_CHARS)}`,
    )
  }

  if (requirement.acceptance && requirement.acceptance.length > 0) {
    lines.push(`Acceptance criteria:\n${requirement.acceptance.map((entry) => `- ${entry}`).join('\n')}`)
  }

  if (requirement.workerId || requirement.workerIdentity || requirement.workerRole) {
    const executorDetails = [
      requirement.workerId ? `Worker ID: ${requirement.workerId}` : null,
      requirement.workerIdentity ? `Worker Identity: ${requirement.workerIdentity}` : null,
      requirement.workerRole ? `Worker Role: ${requirement.workerRole}` : null,
    ]
      .filter((entry): entry is string => entry !== null)
      .join(' | ')
    if (executorDetails) {
      lines.push(`Executor: ${executorDetails}`)
    }
  }

  if (requirement.description || requirement.payload || requirement.objective) {
    if (basePrompt.length > 0) {
      lines.push('Original request context:', truncatePromptSegment(basePrompt, MAX_BASE_PROMPT_CONTEXT_CHARS))
    }
  } else {
    lines.push('Run prompt context:', truncatePromptSegment(basePrompt, MAX_BASE_PROMPT_CONTEXT_CHARS))
  }

  return lines.join('\n\n')
}

const isNumericIssueNumber = (value: string) => /^\d+$/.test(value.trim())

const buildProgressComment = ({
  repository,
  issueNumber,
  stage,
  headBranch,
  baseBranch,
  phase,
  prUrl,
  lastAssistantMessage,
  requirementMetadata,
}: {
  repository: string
  issueNumber: string
  stage: string
  headBranch: string
  baseBranch: string
  phase: 'started' | 'completed' | 'failed'
  prUrl?: string | null
  lastAssistantMessage?: string | null
  requirementMetadata?: RequirementMetadata
}) => {
  const lines = [
    '<!-- codex:progress -->',
    '## Codex implementation progress',
    `- Repository: ${repository}`,
    `- Issue: #${issueNumber}`,
    `- Stage: ${stage}`,
    `- Head: ${headBranch}`,
    `- Base: ${baseBranch}`,
    `- Phase: ${phase}`,
    prUrl ? `- PR: ${prUrl}` : '- PR: n/a',
    `- Updated: ${timestampUtc()}`,
  ]

  if (isHulyRequirementChannel(requirementMetadata?.channel)) {
    const provenance = [
      requirementMetadata?.id ? `- Requirement ID: ${requirementMetadata.id}` : null,
      requirementMetadata?.signal ? `- Signal: ${requirementMetadata.signal}` : null,
      requirementMetadata?.source ? `- Source: ${requirementMetadata.source}` : null,
      requirementMetadata?.target ? `- Target: ${requirementMetadata.target}` : null,
      requirementMetadata?.channel ? `- Channel: ${requirementMetadata.channel}` : null,
      requirementMetadata?.objective ? `- Objective: ${requirementMetadata.objective}` : null,
    ].filter((entry): entry is string => entry !== null)

    if (provenance.length > 0) {
      lines.push('', '### Cross-swarm requirement')
      lines.push(...provenance)
    }

    if (requirementMetadata?.description) {
      lines.push('', '### Requirement description', requirementMetadata.description)
    }
  }

  if (requirementMetadata?.workerId || requirementMetadata?.workerIdentity || requirementMetadata?.workerRole) {
    lines.push('', '### Swarm executor')
    if (requirementMetadata?.workerId) {
      lines.push(`- Worker ID: ${requirementMetadata.workerId}`)
    }
    if (requirementMetadata?.workerIdentity) {
      lines.push(`- Worker Identity: ${requirementMetadata.workerIdentity}`)
    }
    if (requirementMetadata?.workerRole) {
      lines.push(`- Worker Role: ${requirementMetadata.workerRole}`)
    }
  }

  if (lastAssistantMessage) {
    lines.push(
      '',
      '### Last assistant message',
      lastAssistantMessage.length > 1_200 ? `${lastAssistantMessage.slice(0, 1_200)}…` : lastAssistantMessage,
    )
  }

  return `${lines.join('\n')}\n`
}

const postProgressComment = async ({
  logger,
  repository,
  issueNumber,
  stage,
  headBranch,
  baseBranch,
  phase,
  prUrl,
  lastAssistantMessage,
  requirementMetadata,
}: {
  logger: CodexLogger
  repository: string
  issueNumber: string
  stage: string
  headBranch: string
  baseBranch: string
  phase: 'started' | 'completed' | 'failed'
  prUrl?: string | null
  lastAssistantMessage?: string | null
  requirementMetadata?: RequirementMetadata
}) => {
  if (!isNumericIssueNumber(issueNumber)) {
    return
  }

  try {
    await runCodexProgressComment({
      body: buildProgressComment({
        repository,
        issueNumber,
        stage,
        headBranch,
        baseBranch,
        phase,
        prUrl,
        lastAssistantMessage,
        requirementMetadata,
      }),
    })
  } catch (error) {
    logger.warn('Failed to publish Codex progress comment', error)
  }
}

const sanitizeNullableString = (value: string | null | undefined) => {
  if (!value || value === 'null') {
    return ''
  }
  return value
}

const normalizeOptionalString = (value: string | null | undefined) => {
  if (typeof value !== 'string') {
    return undefined
  }
  if (value.trim().length === 0) {
    return undefined
  }
  return value
}

const EVENT_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

const eventKeyToEnvAlias = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()

const eventValueToEnvString = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  return null
}

const exportScalarEventParametersToEnv = (event: ImplementationEventPayload) => {
  for (const [key, value] of Object.entries(event)) {
    const envValue = eventValueToEnvString(value)
    if (envValue === null) {
      continue
    }

    if (EVENT_ENV_NAME_PATTERN.test(key)) {
      process.env[key] = envValue
    }

    const envAlias = eventKeyToEnvAlias(key)
    if (EVENT_ENV_NAME_PATTERN.test(envAlias)) {
      process.env[envAlias] = envValue
      process.env[`CODEX_PARAM_${envAlias}`] = envValue
    }
  }
}

const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

const parseOptionalPrNumber = (value: string): number | null => {
  const normalized = value.trim()
  if (!normalized) {
    return null
  }
  if (/^\d+$/.test(normalized)) {
    const parsed = Number.parseInt(normalized, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }

  const pullPathMatch = normalized.match(/\/pull\/(\d+)(?:[/?#]|$)/i)
  if (pullPathMatch?.[1]) {
    const parsed = Number.parseInt(pullPathMatch[1], 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }

  const hashReferenceMatch = normalized.match(/#(\d+)\b/)
  if (hashReferenceMatch?.[1]) {
    const parsed = Number.parseInt(hashReferenceMatch[1], 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }

  const trailingNumberMatch = normalized.match(/(\d+)\D*$/)
  if (!trailingNumberMatch?.[1]) {
    return null
  }
  const parsed = Number.parseInt(trailingNumberMatch[1], 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed
}

const readOptionalTextFile = async (path: string, logger: CodexLogger) => {
  try {
    if (!(await pathExists(path))) {
      return null
    }
    const raw = await readFile(path, 'utf8')
    const trimmed = raw.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch (error) {
    logger.warn(`Failed to read file at ${path}`, error)
    return null
  }
}

type PullRequestMetadata = {
  number: number | null
  url: string | null
}

const discoverPullRequestMetadata = async ({
  repository,
  headBranch,
  worktree,
  logger,
}: {
  repository: string
  headBranch: string
  worktree: string
  logger: CodexLogger
}): Promise<PullRequestMetadata | null> => {
  try {
    const result = await runCommand(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        repository,
        '--head',
        headBranch,
        '--state',
        'all',
        '--json',
        'number,url',
        '--limit',
        '1',
      ],
      { cwd: worktree },
    )
    if (result.exitCode !== 0) {
      logger.warn('Failed to discover pull request metadata via gh pr list', {
        repository,
        headBranch,
        exitCode: result.exitCode,
        stderr: result.stderr.trim(),
      })
      return null
    }

    const raw = result.stdout.trim()
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as Array<{ number?: number; url?: string }>
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return null
    }

    const first = parsed[0] ?? {}
    const discoveredNumber =
      typeof first.number === 'number' && Number.isFinite(first.number) && first.number > 0 ? first.number : null
    const discoveredUrl = typeof first.url === 'string' && first.url.trim().length > 0 ? first.url.trim() : null
    if (!discoveredNumber && !discoveredUrl) {
      return null
    }

    return {
      number: discoveredNumber,
      url: discoveredUrl,
    }
  } catch (error) {
    logger.warn('Failed to discover pull request metadata via gh', error)
    return null
  }
}

const persistDiscoveredPullRequestMetadata = async ({
  prNumber,
  prUrl,
  prNumberPath,
  prUrlPath,
  logger,
}: {
  prNumber: number | null
  prUrl: string | null
  prNumberPath: string
  prUrlPath: string
  logger: CodexLogger
}) => {
  try {
    if (prNumber !== null) {
      await ensureFileDirectory(prNumberPath)
      await writeFile(prNumberPath, `${prNumber}\n`, 'utf8')
    }
    if (prUrl) {
      await ensureFileDirectory(prUrlPath)
      await writeFile(prUrlPath, `${prUrl}\n`, 'utf8')
    }
  } catch (error) {
    logger.warn('Failed to persist discovered pull request metadata', error)
  }
}

const VALID_STAGES = new Set(['implementation', 'verify', 'review', 'planning', 'research'])

const normalizeStage = (value: string | null | undefined) => {
  if (!value) return 'implementation'
  const trimmed = value.trim().toLowerCase()
  return VALID_STAGES.has(trimmed) ? trimmed : 'implementation'
}

type CodexNotifyLogExcerpt = {
  output?: string | null
  events?: string | null
  agent?: string | null
  runtime?: string | null
  status?: string | null
}

type CodexNotifyPayload = {
  type: 'agent-turn-complete'
  repository: string
  issue_number: string
  issueNumber?: string
  base_branch: string
  head_branch: string
  workflow_name: string | null
  workflow_namespace: string | null
  workflowName?: string | null
  workflowNamespace?: string | null
  commit_sha?: string | null
  commitSha?: string | null
  head_sha?: string | null
  headSha?: string | null
  pr_number?: number | null
  pr_url?: string | null
  prNumber?: number | null
  prUrl?: string | null
  session_id: string | null
  branch?: string | null
  prompt: string
  stage?: string | null
  context_soak?: {
    fetched: number
    filtered: number
    messages: Array<Record<string, unknown>>
  } | null
  memory_soak?: {
    fetched: number
    query: string
    namespace: string
    memories: Array<Record<string, unknown>>
  } | null
  iteration?: number | null
  iteration_cycle?: number | null
  iterations?: number | null
  input_messages: string[]
  last_assistant_message: string | null
  logs?: CodexNotifyLogExcerpt
  output_paths: Record<string, string>
  log_excerpt?: CodexNotifyLogExcerpt
  issued_at: string
  cross_swarm_requirement?: boolean
  swarm_requirement?: {
    id?: string
    signal?: string
    source?: string
    target?: string
    channel?: string
    description?: string
    objective?: string
    swarmRequirementObjective?: string
    payload?: string
    payloadBytes?: string
    payloadTruncated?: boolean
  }
  swarmRequirementId?: string | null
  swarmRequirementSignal?: string | null
  swarmRequirementSource?: string | null
  swarmRequirementTarget?: string | null
  swarmRequirementChannel?: string | null
  swarmRequirementDescription?: string | null
  swarmRequirementObjective?: string | null
  swarmRequirementPayload?: string | null
  swarmRequirementPayloadBytes?: string | null
  swarmRequirementPayloadTruncated?: boolean | null
  swarmAgentWorkerId?: string | null
  swarmAgentIdentity?: string | null
  swarmAgentRole?: string | null
  swarmHumanName?: string | null
}

const MAX_NOTIFY_LOG_CHARS = 12_000

type NatsContextPayload = {
  fetched: number
  filtered: number
  messages: Array<Record<string, unknown>>
}

type MemoryRecord = {
  id?: string
  content?: string | null
  summary?: string | null
  tags?: string[]
  metadata?: Record<string, unknown>
  createdAt?: string | null
}

type MemoryContextPayload = {
  fetched: number
  query: string
  namespace: string
  memories: MemoryRecord[]
}

const truncateLogContent = (content: string) => {
  if (content.length <= MAX_NOTIFY_LOG_CHARS) {
    return content
  }
  const truncatedCount = content.length - MAX_NOTIFY_LOG_CHARS
  return `...[truncated ${truncatedCount} chars]\n${content.slice(-MAX_NOTIFY_LOG_CHARS)}`
}

const readLogExcerpt = async (path: string, logger?: CodexLogger) => {
  try {
    if (!(await pathExists(path))) {
      return null
    }
    const content = await readFile(path, 'utf8')
    if (!content) {
      return ''
    }
    return truncateLogContent(content)
  } catch (error) {
    logger?.warn(`Failed to read log excerpt from ${path}`, error)
    return null
  }
}

const collectLogExcerpts = async (
  {
    outputPath,
    jsonOutputPath,
    agentOutputPath,
    runtimeLogPath,
    statusPath,
  }: {
    outputPath: string
    jsonOutputPath: string
    agentOutputPath: string
    runtimeLogPath: string
    statusPath: string
  },
  logger?: CodexLogger,
): Promise<CodexNotifyLogExcerpt> => {
  const [output, events, agent, runtime, status] = await Promise.all([
    readLogExcerpt(outputPath, logger),
    readLogExcerpt(jsonOutputPath, logger),
    readLogExcerpt(agentOutputPath, logger),
    readLogExcerpt(runtimeLogPath, logger),
    readLogExcerpt(statusPath, logger),
  ])
  return {
    output,
    events,
    agent,
    runtime,
    status,
  }
}

const resolveHeadSha = async (worktree: string, logger: CodexLogger) => {
  try {
    const result = await runCommand('git', ['rev-parse', 'HEAD'], { cwd: worktree })
    if (result.exitCode === 0) {
      return result.stdout.trim() || null
    }
    logger.warn(`git rev-parse HEAD failed: ${result.stderr.trim() || result.stdout.trim()}`)
  } catch (error) {
    logger.warn('git rev-parse HEAD threw', error)
  }
  return null
}

const initializeOutputFiles = async (paths: string[], logger: CodexLogger) => {
  await Promise.all(
    paths.map(async (path) => {
      try {
        await ensureFileDirectory(path)
        await writeFile(path, '', { flag: 'a' })
      } catch (error) {
        logger.warn(`Failed to initialize output file at ${path}`, error)
      }
    }),
  )
}

const buildNotifyPayload = ({
  repository,
  issueNumber,
  baseBranch,
  headBranch,
  prompt,
  stage,
  outputPath,
  jsonOutputPath,
  agentOutputPath,
  runtimeLogPath,
  statusPath,
  patchPath,
  archivePath,
  notifyPath,
  manifestPath,
  headShaPath,
  commitShaPath,
  prNumberPath,
  prUrlPath,
  sessionId,
  lastAssistantMessage,
  logExcerpt,
  commitSha,
  headSha,
  prNumber,
  prUrl,
  contextSoak,
  memorySoak,
  iteration,
  iterationCycle,
  iterations,
  requirementMetadata,
  hulyArtifacts,
}: {
  repository: string
  issueNumber: string
  baseBranch: string
  headBranch: string
  prompt: string
  stage: string
  outputPath: string
  jsonOutputPath: string
  agentOutputPath: string
  runtimeLogPath: string
  statusPath: string
  patchPath: string
  archivePath: string
  notifyPath: string
  manifestPath: string
  headShaPath: string
  commitShaPath: string
  prNumberPath: string
  prUrlPath: string
  sessionId?: string
  lastAssistantMessage?: string | null
  logExcerpt?: CodexNotifyLogExcerpt
  commitSha?: string | null
  headSha?: string | null
  prNumber?: number | null
  prUrl?: string | null
  contextSoak?: NatsContextPayload | null
  memorySoak?: MemoryContextPayload | null
  iteration?: number | null
  iterationCycle?: number | null
  iterations?: number | null
  requirementMetadata?: RequirementMetadata
  hulyArtifacts?: HulyRequirementArtifacts
}): CodexNotifyPayload => {
  return {
    type: 'agent-turn-complete',
    repository,
    issue_number: issueNumber,
    issueNumber,
    base_branch: baseBranch,
    head_branch: headBranch,
    workflow_name: process.env.ARGO_WORKFLOW_NAME ?? null,
    workflow_namespace: process.env.ARGO_WORKFLOW_NAMESPACE ?? null,
    workflowName: process.env.ARGO_WORKFLOW_NAME ?? null,
    workflowNamespace: process.env.ARGO_WORKFLOW_NAMESPACE ?? null,
    commit_sha: commitSha ?? null,
    commitSha: commitSha ?? null,
    head_sha: headSha ?? commitSha ?? null,
    headSha: headSha ?? commitSha ?? null,
    pr_number: prNumber ?? null,
    pr_url: prUrl ?? null,
    prNumber: prNumber ?? null,
    prUrl: prUrl ?? null,
    session_id: sessionId ?? null,
    branch: headBranch || null,
    prompt,
    stage,
    context_soak: contextSoak ?? null,
    memory_soak: memorySoak ?? null,
    iteration: iteration ?? null,
    iteration_cycle: iterationCycle ?? null,
    iterations: iterations ?? null,
    input_messages: [prompt],
    last_assistant_message: lastAssistantMessage ?? null,
    logs: logExcerpt,
    output_paths: {
      output: outputPath,
      events: jsonOutputPath,
      agent: agentOutputPath,
      runtime: runtimeLogPath,
      status: statusPath,
      patch: patchPath,
      changes: archivePath,
      notify: notifyPath,
      changes_manifest: manifestPath,
      head_sha: headShaPath,
      commit_sha: commitShaPath,
      pr_number: prNumberPath,
      pr_url: prUrlPath,
    },
    log_excerpt: logExcerpt,
    issued_at: new Date().toISOString(),
    cross_swarm_requirement: isHulyRequirementChannel(requirementMetadata?.channel),
    swarm_requirement: {
      id: requirementMetadata?.id,
      signal: requirementMetadata?.signal,
      source: requirementMetadata?.source,
      target: requirementMetadata?.target,
      channel: requirementMetadata?.channel,
      description: requirementMetadata?.description,
      objective: requirementMetadata?.objective,
      payload: requirementMetadata?.payload,
      payloadBytes: requirementMetadata?.payloadBytes,
      payloadTruncated: requirementMetadata?.payloadTruncated,
    },
    swarmRequirementId: requirementMetadata?.id ?? null,
    swarmRequirementSignal: requirementMetadata?.signal ?? null,
    swarmRequirementSource: requirementMetadata?.source ?? null,
    swarmRequirementTarget: requirementMetadata?.target ?? null,
    swarmRequirementChannel: requirementMetadata?.channel ?? null,
    swarmRequirementDescription: requirementMetadata?.description ?? null,
    swarmRequirementObjective: requirementMetadata?.objective ?? null,
    swarmRequirementPayload: requirementMetadata?.payload ?? null,
    swarmRequirementPayloadBytes: requirementMetadata?.payloadBytes ?? null,
    swarmRequirementPayloadTruncated: requirementMetadata?.payloadTruncated ?? null,
    swarmAgentWorkerId: requirementMetadata?.workerId ?? null,
    swarmAgentIdentity: requirementMetadata?.workerIdentity ?? null,
    swarmAgentRole: requirementMetadata?.workerRole ?? null,
    swarmHumanName: requirementMetadata?.workerHumanName ?? null,
    hulyArtifacts: collectHulyArtifactsForNotify(hulyArtifacts),
  }
}

const sleep = async (durationMs: number) =>
  await new Promise<void>((resolve) => {
    setTimeout(resolve, durationMs)
  })

const postNotifyPayload = async (payload: CodexNotifyPayload, logger: CodexLogger) => {
  const baseUrl = sanitizeNullableString(process.env.CODEX_NOTIFY_URL ?? process.env.JANGAR_BASE_URL ?? '')
  if (!baseUrl) {
    logger.warn('Notify disabled: missing CODEX_NOTIFY_URL or JANGAR_BASE_URL')
    return
  }

  const notifyUrl = baseUrl.endsWith('/api/codex/notify') ? baseUrl : `${baseUrl.replace(/\/$/, '')}/api/codex/notify`
  const maxAttempts = 4
  const baseDelayMs = 1000
  const maxDelayMs = 10000
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(notifyUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (response.ok) {
        if (attempt > 1) {
          logger.info(`Notify delivered after ${attempt} attempts`)
        }
        return
      }

      const body = await response.text()
      const bodySuffix = body ? `: ${body}` : ''
      lastError = new Error(`Notify failed (${response.status})${bodySuffix}`)
      logger.warn(`Notify failed (attempt ${attempt}/${maxAttempts}, status ${response.status})${bodySuffix}`)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Notify request failed')
      logger.warn(`Notify request failed (attempt ${attempt}/${maxAttempts})`, error)
    }

    if (attempt < maxAttempts) {
      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)
      logger.debug(`Retrying notify in ${delayMs}ms`, { attempt, maxAttempts })
      await sleep(delayMs)
    }
  }

  if (lastError) {
    logger.warn('Notify failed after retries', lastError)
  }
}

interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

const extractSectionLines = (text: string, header: string) => {
  const lines = text.replace(/\r/g, '').split('\n')
  const headerIndex = lines.findIndex((line) => line.trim().toLowerCase().startsWith(header.toLowerCase()))
  if (headerIndex < 0) return []
  const collected: string[] = []
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]?.trim()
    if (!line) {
      if (collected.length > 0) break
      continue
    }
    if (/^[A-Za-z].*:/.test(line)) break
    collected.push(line)
  }
  return collected
}

const extractSummary = (message?: string | null) => {
  if (!message) return null
  const summaryLines = extractSectionLines(message, 'Summary')
  if (summaryLines.length > 0) {
    return summaryLines.map((line) => line.replace(/^[-*]\s*/, '')).join(' ')
  }
  const firstLine = message
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return firstLine ?? null
}

const extractTests = (message?: string | null) => {
  if (!message) return []
  const testLines = extractSectionLines(message, 'Tests')
  return testLines.map((line) => line.replace(/^[-*]\s*/, '')).filter(Boolean)
}

const extractKnownGaps = (message?: string | null) => {
  if (!message) return []
  const gapLines = extractSectionLines(message, 'Known gaps')
  if (gapLines.length > 0) return gapLines.map((line) => line.replace(/^[-*]\s*/, '')).filter(Boolean)
  const altLines = extractSectionLines(message, 'Gaps')
  return altLines.map((line) => line.replace(/^[-*]\s*/, '')).filter(Boolean)
}

const runCommand = async (
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> => {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawnChild(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('error', (error) => {
      reject(error)
    })

    child.on('close', (code) => {
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
      })
    })
  })
}

const splitNonEmptyLines = (value: string) =>
  value
    .replace(/\r/g, '')
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

const isMeaningfulRepositoryPath = (filePath: string) => {
  const normalized = filePath.replace(/^\.?\//, '')
  if (!normalized || normalized.startsWith('.git/')) {
    return false
  }
  return !(
    normalized.startsWith('.codex') ||
    normalized.startsWith('.agentrun/') ||
    normalized.startsWith('tmp/') ||
    normalized.startsWith('temp/')
  )
}

const collectMeaningfulRepositoryChanges = async ({
  worktree,
  baseBranch,
  logger,
}: {
  worktree: string
  baseBranch: string
  logger: CodexLogger
}) => {
  const changed = new Set<string>()
  const baseCandidates = [baseBranch ? `origin/${baseBranch}` : '', baseBranch].filter(
    (candidate) => candidate && candidate.trim().length > 0,
  )
  let resolvedBaseRef: string | null = null
  for (const candidate of baseCandidates) {
    const result = await runCommand('git', ['rev-parse', '--verify', candidate], { cwd: worktree })
    if (result.exitCode === 0) {
      resolvedBaseRef = candidate
      break
    }
  }

  try {
    if (resolvedBaseRef) {
      const committedResult = await runCommand('git', ['diff', '--name-only', `${resolvedBaseRef}...HEAD`], {
        cwd: worktree,
      })
      if (committedResult.exitCode === 0) {
        for (const filePath of splitNonEmptyLines(committedResult.stdout)) {
          if (isMeaningfulRepositoryPath(filePath)) {
            changed.add(filePath)
          }
        }
      }
    }
    const workingTreeResult = await runCommand('git', ['diff', '--name-only'], { cwd: worktree })
    if (workingTreeResult.exitCode === 0) {
      for (const filePath of splitNonEmptyLines(workingTreeResult.stdout)) {
        if (isMeaningfulRepositoryPath(filePath)) {
          changed.add(filePath)
        }
      }
    }
    const stagedResult = await runCommand('git', ['diff', '--name-only', '--cached'], { cwd: worktree })
    if (stagedResult.exitCode === 0) {
      for (const filePath of splitNonEmptyLines(stagedResult.stdout)) {
        if (isMeaningfulRepositoryPath(filePath)) {
          changed.add(filePath)
        }
      }
    }
    const untrackedResult = await runCommand('git', ['ls-files', '--others', '--exclude-standard'], { cwd: worktree })
    if (untrackedResult.exitCode === 0) {
      for (const filePath of splitNonEmptyLines(untrackedResult.stdout)) {
        if (isMeaningfulRepositoryPath(filePath)) {
          changed.add(filePath)
        }
      }
    }
  } catch (error) {
    logger.warn('Failed to collect repository change list for completion policy', error)
  }

  return Array.from(changed).sort()
}

const readEvidenceValue = (event: ImplementationEventPayload, keys: string[]) => {
  const parameters = asStringMap(event.parameters)
  const record = event as unknown as Record<string, unknown>
  for (const key of keys) {
    const payloadValue = normalizeNullableStringValue(record[key] as string | number | boolean | null | undefined)
    if (payloadValue) {
      return payloadValue
    }
    const parameterValue = normalizeNullableStringValue(parameters[key])
    if (parameterValue) {
      return parameterValue
    }
  }
  return undefined
}

const readEvidenceBool = (event: ImplementationEventPayload, keys: string[]) => {
  const value = readEvidenceValue(event, keys)
  if (!value) {
    return false
  }
  return parseBool(value)
}

const hasMergeEvidenceText = (text: string | null | undefined) => {
  if (!text) {
    return false
  }
  const normalized = text.replace(/\s+/g, ' ')
  const mentionsMerge = /\b(merged|merge commit|squash[- ]merged|merged commit)\b/i.test(normalized)
  const hasReference =
    /https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i.test(normalized) ||
    /\bpr\s*#?\d+\b/i.test(normalized) ||
    /\bcommit\s+[0-9a-f]{7,40}\b/i.test(normalized)
  return mentionsMerge && hasReference
}

const hasRolloutEvidenceText = (text: string | null | undefined) => {
  if (!text) {
    return false
  }
  return (
    /\brollout\b.{0,80}\b(healthy|green|completed|successful|ready)\b/i.test(text) ||
    /\b(in-?cluster|cluster)\b.{0,80}\b(healthy|ready|stable)\b/i.test(text) ||
    /\b(workload|deployment|statefulset)\b.{0,80}\b(ready|healthy)\b/i.test(text) ||
    /\b(no|zero)\s+error\s+events\b/i.test(text)
  )
}

const hasGreenChecksEvidenceText = (text: string | null | undefined) => {
  if (!text) {
    return false
  }
  const normalized = text.replace(/\s+/g, ' ')
  const positive =
    /\b(required\s+checks?|all\s+checks?|ci)\b.{0,60}\b(green|pass(?:ed|ing)?|succeed(?:ed|ing)?)\b/i.test(
      normalized,
    ) || /\bchecks?\s*:\s*green\b/i.test(normalized)
  if (!positive) {
    return false
  }
  return !/\b(checks?|ci)\b.{0,40}\b(fail(?:ed|ing)?|pending|blocked|cancel(?:led|ed)?)\b/i.test(normalized)
}

type PullRequestCheckVerification = {
  verified: boolean
  green: boolean
  source: 'gh-pr-checks' | 'gh-pr-view' | 'none'
}

type PullRequestMergeVerification = {
  verified: boolean
  merged: boolean
  mergeCommitSha?: string
  source: 'gh-pr-view' | 'none'
}

type ReleaseRolloutVerification = {
  verified: boolean
  healthy: boolean
  source: 'argocd-app' | 'kubectl-rollout' | 'none'
}

const classifyCheckState = (value: string | null | undefined) => {
  const normalized = (value ?? '').trim().toLowerCase()
  if (!normalized) {
    return 'unknown' as const
  }
  if (
    normalized.includes('pass') ||
    normalized.includes('success') ||
    normalized.includes('green') ||
    normalized.includes('neutral') ||
    normalized.includes('skip')
  ) {
    return 'pass' as const
  }
  if (
    normalized.includes('pending') ||
    normalized.includes('queued') ||
    normalized.includes('running') ||
    normalized.includes('in_progress') ||
    normalized.includes('in-progress') ||
    normalized.includes('requested') ||
    normalized.includes('waiting')
  ) {
    return 'pending' as const
  }
  if (normalized.includes('complete')) {
    return 'pass' as const
  }
  return 'fail' as const
}

const evaluateCheckEntriesGreen = (entries: Array<Record<string, unknown>>) => {
  if (entries.length === 0) {
    return false
  }
  for (const entry of entries) {
    const candidateState =
      normalizeNullableStringValue(entry.state as string | number | boolean | null | undefined) ??
      normalizeNullableStringValue(entry.conclusion as string | number | boolean | null | undefined) ??
      normalizeNullableStringValue(entry.status as string | number | boolean | null | undefined)
    if (classifyCheckState(candidateState) !== 'pass') {
      return false
    }
  }
  return true
}

const verifyPullRequestChecksWithGh = async ({
  repository,
  prUrl,
  worktree,
  logger,
}: {
  repository: string
  prUrl: string | null
  worktree: string
  logger: CodexLogger
}): Promise<PullRequestCheckVerification> => {
  const prNumber = prUrl ? parseOptionalPrNumber(prUrl) : null
  if (!prNumber) {
    return { verified: false, green: false, source: 'none' }
  }

  const prChecksResult = await runCommand(
    'gh',
    ['pr', 'checks', String(prNumber), '--repo', repository, '--json', 'name,state'],
    { cwd: worktree },
  )
  if (prChecksResult.exitCode === 0) {
    try {
      const parsed = JSON.parse(prChecksResult.stdout) as Array<Record<string, unknown>> | Record<string, unknown>
      const entries = Array.isArray(parsed) ? parsed : []
      if (entries.length > 0) {
        return {
          verified: true,
          green: evaluateCheckEntriesGreen(entries),
          source: 'gh-pr-checks',
        }
      }
    } catch (error) {
      logger.warn('Failed to parse gh pr checks payload; falling back to gh pr view', error)
    }
  }

  const prViewResult = await runCommand(
    'gh',
    ['pr', 'view', String(prNumber), '--repo', repository, '--json', 'statusCheckRollup'],
    { cwd: worktree },
  )
  if (prViewResult.exitCode !== 0) {
    const message = prViewResult.stderr.trim() || prChecksResult.stderr.trim() || 'unable to verify checks with gh'
    logger.warn(`Unable to verify required checks via gh: ${message}`)
    return { verified: false, green: false, source: 'none' }
  }

  try {
    const parsed = JSON.parse(prViewResult.stdout) as { statusCheckRollup?: Array<Record<string, unknown>> }
    const entries = Array.isArray(parsed.statusCheckRollup) ? parsed.statusCheckRollup : []
    if (entries.length === 0) {
      return { verified: false, green: false, source: 'none' }
    }
    return {
      verified: true,
      green: evaluateCheckEntriesGreen(entries),
      source: 'gh-pr-view',
    }
  } catch (error) {
    logger.warn('Failed to parse gh pr view statusCheckRollup payload', error)
    return { verified: false, green: false, source: 'none' }
  }
}

const verifyPullRequestMergedWithGh = async ({
  repository,
  prUrl,
  worktree,
  logger,
}: {
  repository: string
  prUrl: string | null
  worktree: string
  logger: CodexLogger
}): Promise<PullRequestMergeVerification> => {
  const prNumber = prUrl ? parseOptionalPrNumber(prUrl) : null
  if (!prNumber) {
    return { verified: false, merged: false, source: 'none' }
  }

  const prViewResult = await runCommand(
    'gh',
    ['pr', 'view', String(prNumber), '--repo', repository, '--json', 'state,mergedAt,mergeCommit'],
    { cwd: worktree },
  )
  if (prViewResult.exitCode !== 0) {
    const message = prViewResult.stderr.trim() || prViewResult.stdout.trim() || 'unable to verify merge state with gh'
    logger.warn(`Unable to verify merge evidence via gh: ${message}`)
    return { verified: false, merged: false, source: 'none' }
  }

  try {
    const parsed = JSON.parse(prViewResult.stdout) as {
      state?: string
      mergedAt?: string | null
      mergeCommit?: { oid?: string | null } | null
    }
    const mergedAt = normalizeNullableStringValue(parsed.mergedAt ?? undefined)
    const mergeCommitSha = normalizeNullableStringValue(parsed.mergeCommit?.oid ?? undefined)
    const state = normalizeNullableStringValue(parsed.state ?? undefined)
    const merged = Boolean(mergedAt || mergeCommitSha || (state && state.toLowerCase() === 'merged'))
    return {
      verified: true,
      merged,
      mergeCommitSha: mergeCommitSha ?? undefined,
      source: 'gh-pr-view',
    }
  } catch (error) {
    logger.warn('Failed to parse gh pr view merge payload', error)
    return { verified: false, merged: false, source: 'none' }
  }
}

const verifyReleaseRolloutWithCluster = async ({
  event,
  worktree,
  logger,
}: {
  event: ImplementationEventPayload
  worktree: string
  logger: CodexLogger
}): Promise<ReleaseRolloutVerification> => {
  const argocdAppName = readEvidenceValue(event, ['argocdAppName', 'argoAppName', 'rolloutAppName'])
  const argocdAppNamespace = readEvidenceValue(event, ['argocdAppNamespace']) ?? 'argocd'
  if (argocdAppName) {
    const result = await runCommand(
      'kubectl',
      ['get', 'applications.argoproj.io', argocdAppName, '-n', argocdAppNamespace, '-o', 'json'],
      { cwd: worktree },
    )
    if (result.exitCode === 0) {
      try {
        const payload = JSON.parse(result.stdout) as {
          status?: { sync?: { status?: string | null }; health?: { status?: string | null } }
        }
        const syncStatus = normalizeNullableStringValue(payload.status?.sync?.status ?? undefined)
        const healthStatus = normalizeNullableStringValue(payload.status?.health?.status ?? undefined)
        const healthy = syncStatus === 'Synced' && healthStatus === 'Healthy'
        return { verified: true, healthy, source: 'argocd-app' }
      } catch (error) {
        logger.warn('Failed to parse ArgoCD application health payload', error)
      }
    } else {
      logger.warn(
        `Failed to verify ArgoCD application health via kubectl: ${result.stderr.trim() || result.stdout.trim()}`,
      )
    }
  }

  const rolloutNamespace = readEvidenceValue(event, ['rolloutNamespace', 'deploymentNamespace']) ?? 'default'
  const rolloutKind = (readEvidenceValue(event, ['rolloutKind', 'deploymentKind']) ?? '').toLowerCase()
  const rolloutName = readEvidenceValue(event, ['rolloutName', 'deploymentName', 'rolloutResourceName'])
  if (rolloutKind && rolloutName) {
    const timeoutSecondsRaw = readEvidenceValue(event, ['rolloutTimeoutSeconds'])
    const timeoutSeconds = timeoutSecondsRaw ? Number.parseInt(timeoutSecondsRaw, 10) : 600
    const timeout = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 600
    const rolloutResource = `${rolloutKind}/${rolloutName}`
    const result = await runCommand(
      'kubectl',
      ['rollout', 'status', rolloutResource, '-n', rolloutNamespace, `--timeout=${timeout}s`],
      { cwd: worktree },
    )
    return {
      verified: true,
      healthy: result.exitCode === 0,
      source: 'kubectl-rollout',
    }
  }

  return { verified: false, healthy: false, source: 'none' }
}

type RoleCompletionEvidence = {
  changedFiles: string[]
  architectMergeEvidence: boolean
  engineerChecksGreen: boolean
  releaseMergeEvidence: boolean
  releaseRolloutEvidence: boolean
}

const evaluateRoleCompletionEvidence = async ({
  lane,
  event,
  repository,
  prUrl,
  worktree,
  baseBranch,
  lastAssistantMessage,
  logger,
}: {
  lane: SwarmExecutionLane
  event: ImplementationEventPayload
  repository: string
  prUrl: string | null
  worktree: string
  baseBranch: string
  lastAssistantMessage: string | null
  logger: CodexLogger
}): Promise<RoleCompletionEvidence> => {
  const changedFiles =
    lane === 'architect' ? await collectMeaningfulRepositoryChanges({ worktree, baseBranch, logger }) : []
  const strictRoleEvidence = parseBoolean(process.env.CODEX_STRICT_ROLE_EVIDENCE, true)
  const allowHeuristicEvidence = parseBoolean(process.env.CODEX_ALLOW_HEURISTIC_EVIDENCE, false)

  const explicitMergeEvidence =
    readEvidenceBool(event, ['merged', 'mergeCompleted', 'mergedCommit']) ||
    Boolean(
      readEvidenceValue(event, [
        'mergedPrUrl',
        'mergePrUrl',
        'mergedCommitSha',
        'mergeCommitSha',
        'mergeSha',
        'mergeCommit',
      ]),
    )
  let mergeEvidence = explicitMergeEvidence
  if (allowHeuristicEvidence) {
    mergeEvidence = mergeEvidence || hasMergeEvidenceText(lastAssistantMessage)
  }
  const verifyMergeWithGh = parseBoolean(process.env.CODEX_VERIFY_MERGE_WITH_GH, true)
  if (verifyMergeWithGh && prUrl) {
    const ghMerge = await verifyPullRequestMergedWithGh({ repository, prUrl, worktree, logger })
    if (ghMerge.verified) {
      mergeEvidence = ghMerge.merged
    } else if (strictRoleEvidence) {
      mergeEvidence = false
    }
  }

  const explicitChecksGreen = readEvidenceBool(event, ['checksGreen', 'requiredChecksGreen', 'ciGreen'])
  const verifyWithGh = parseBoolean(process.env.CODEX_VERIFY_PR_CHECKS_WITH_GH, true)
  let engineerChecksGreen = explicitChecksGreen
  if (allowHeuristicEvidence) {
    engineerChecksGreen = engineerChecksGreen || hasGreenChecksEvidenceText(lastAssistantMessage)
  }
  if (verifyWithGh && prUrl) {
    const ghChecks = await verifyPullRequestChecksWithGh({ repository, prUrl, worktree, logger })
    if (ghChecks.verified) {
      engineerChecksGreen = ghChecks.green
    } else if (strictRoleEvidence) {
      engineerChecksGreen = false
    }
  }

  const explicitRolloutEvidence = readEvidenceBool(event, ['rolloutHealthy', 'rolloutVerified', 'inClusterHealthy'])
  let rolloutEvidence = explicitRolloutEvidence
  if (allowHeuristicEvidence) {
    rolloutEvidence = rolloutEvidence || hasRolloutEvidenceText(lastAssistantMessage)
  }
  const verifyReleaseRolloutWithClusterEnabled = parseBoolean(
    process.env.CODEX_VERIFY_RELEASE_ROLLOUT_WITH_CLUSTER,
    true,
  )
  if (lane === 'release' && verifyReleaseRolloutWithClusterEnabled) {
    const rolloutVerification = await verifyReleaseRolloutWithCluster({ event, worktree, logger })
    if (rolloutVerification.verified) {
      rolloutEvidence = rolloutVerification.healthy
    } else if (strictRoleEvidence && !explicitRolloutEvidence) {
      rolloutEvidence = false
    }
  }

  return {
    changedFiles,
    architectMergeEvidence: mergeEvidence,
    engineerChecksGreen,
    releaseMergeEvidence: mergeEvidence,
    releaseRolloutEvidence: rolloutEvidence,
  }
}

const parseModelCandidates = (raw: string | undefined) => {
  if (!raw) {
    return []
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

const detectProviderThrottle = (value: string | undefined) => {
  if (!value) {
    return false
  }
  return /rate limit|too many requests|429|quota|insufficient_quota|capacity|overloaded|provider timeout/i.test(value)
}

const buildLaneCompletionReminders = (lane: SwarmExecutionLane) => {
  if (lane === 'architect') {
    return [
      'Architect completion bar: merged architecture/design outputs with explicit implementation and rollout/rollback gates.',
      'Do not stop at draft notes or unmerged PRs.',
    ]
  }
  if (lane === 'release') {
    return [
      'Release completion bar: selected PRs merged with green required checks and healthy rollout evidence.',
      'Do not claim done without merge + rollout verification.',
    ]
  }
  return [
    'Engineer completion bar: highest-priority runtime requirement implemented in a merge-ready PR with green required checks.',
    'Do not stop at partial implementation or non-green checks.',
  ]
}

const buildProviderFallbackPrompt = ({
  repository,
  issueNumber,
  stage,
  lane,
  objective,
}: {
  repository: string
  issueNumber: string
  stage: string
  lane: SwarmExecutionLane
  objective?: string
}) => {
  const laneReminders = buildLaneCompletionReminders(lane)
  const lines = [
    'Previous attempt failed due to transient provider throttling/quota constraints.',
    'Resume immediately from current workspace state and finish the same task end-to-end.',
    `Repository: ${repository}`,
    `Issue: ${issueNumber}`,
    `Stage: ${stage}`,
    `Execution lane: ${lane}`,
    objective ? `Objective: ${objective}` : null,
    ...laneReminders,
    'Preserve thread-aware, human teammate communication in Huly updates.',
  ].filter((line): line is string => Boolean(line))
  return lines.join('\n')
}

const normalizeCloneBaseUrl = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  const withScheme = trimmed.includes('://') ? trimmed : `https://${trimmed}`
  try {
    const parsed = new URL(withScheme)
    const pathname = parsed.pathname.replace(/\/+$/, '')
    return `${parsed.protocol}//${parsed.host}${pathname}`
  } catch {
    return null
  }
}

const resolveRepositoryCloneUrl = (repository: string) => {
  const explicitRepositoryUrl = normalizeOptionalString(
    sanitizeNullableString(process.env.VCS_REPOSITORY_URL ?? process.env.REPO_URL),
  )
  if (explicitRepositoryUrl) {
    return explicitRepositoryUrl
  }

  const cloneBaseUrl = normalizeOptionalString(
    sanitizeNullableString(process.env.VCS_CLONE_BASE_URL ?? process.env.VCS_WEB_BASE_URL),
  )
  const normalizedBase = cloneBaseUrl ? normalizeCloneBaseUrl(cloneBaseUrl) : null
  if (normalizedBase) {
    return `${normalizedBase}/${repository}.git`
  }

  return `https://github.com/${repository}.git`
}

const ensureWorktreeCheckout = async ({
  worktree,
  repository,
  logger,
}: {
  worktree: string
  repository: string
  logger: CodexLogger
}) => {
  const gitDir = join(worktree, '.git')
  if (await pathExists(gitDir)) {
    return
  }

  await mkdir(dirname(worktree), { recursive: true })

  if (await pathExists(worktree)) {
    const existingEntries = await readdir(worktree)
    if (existingEntries.length > 0) {
      logger.warn(`Worktree ${worktree} exists without .git; recreating checkout before implementation run`)
      await rm(worktree, { recursive: true, force: true })
    }
  }

  const cloneUrl = resolveRepositoryCloneUrl(repository)
  logger.info(`Bootstrapping repository checkout into ${worktree} from ${cloneUrl}`)
  const cloneResult = await runCommand('git', ['clone', cloneUrl, worktree])
  if (cloneResult.exitCode !== 0) {
    const output = [cloneResult.stderr, cloneResult.stdout].filter(Boolean).join('\n').trim()
    throw new Error(`git clone failed (exit ${cloneResult.exitCode})${output ? `: ${output}` : ''}`)
  }
}

const resolveBaseRef = async (worktree: string, baseBranch: string, logger: CodexLogger) => {
  const candidates = [baseBranch ? `origin/${baseBranch}` : '', baseBranch, 'HEAD^'].filter(
    (value) => value && value.trim().length > 0,
  )
  for (const candidate of candidates) {
    const result = await runCommand('git', ['rev-parse', '--verify', candidate], { cwd: worktree })
    if (result.exitCode === 0) {
      return candidate
    }
  }
  logger.warn('Failed to resolve base ref for implementation artifacts', { baseBranch, candidates })
  return null
}

const truncateContextLine = (value: string, max = 400) => {
  if (value.length <= max) return value
  return `${value.slice(0, max)}…`
}

const formatMemoryContextBlock = (payload: MemoryContextPayload | null, maxMemories = 6) => {
  if (!payload || payload.memories.length === 0) return ''
  const memories = payload.memories.slice(0, maxMemories)
  const lines = memories.map((memory) => {
    const summary =
      typeof memory.summary === 'string' && memory.summary.trim().length > 0 ? memory.summary.trim() : 'memory'
    const created =
      typeof memory.createdAt === 'string' && memory.createdAt.trim().length > 0 ? memory.createdAt : 'unknown-time'
    const content =
      typeof memory.content === 'string' && memory.content.trim().length > 0
        ? truncateContextLine(memory.content.trim(), 600)
        : ''
    return `- [${created}] ${summary}${content ? ` :: ${content}` : ''}`
  })
  return `Jangar memory snapshots (namespace=${payload.namespace}, query="${payload.query}"):\n${lines.join('\n')}`
}

const formatNatsContextBlock = (payload: NatsContextPayload | null, maxMessages = 25) => {
  if (!payload || payload.messages.length === 0) return ''
  const messages = payload.messages.slice(-maxMessages)
  const lines = messages.map((message) => {
    const timestamp =
      typeof message.timestamp === 'string'
        ? message.timestamp
        : typeof message.sent_at === 'string'
          ? message.sent_at
          : 'unknown-time'
    const kind = typeof message.kind === 'string' ? message.kind : 'message'
    const content =
      typeof message.content === 'string' && message.content.trim().length > 0
        ? message.content.trim()
        : message.attrs
          ? JSON.stringify(message.attrs)
          : JSON.stringify(message)
    return `- [${timestamp}] (${kind}) ${truncateContextLine(content, 500)}`
  })
  return `Context soak from NATS general channel (latest ${messages.length} of ${payload.filtered}):\n${lines.join('\n')}`
}

const fetchNatsContext = async ({
  logger,
  required,
  outputPath,
}: {
  logger: CodexLogger
  required: boolean
  outputPath: string
}): Promise<NatsContextPayload | null> => {
  if (!process.env.NATS_URL) {
    if (required) {
      throw new Error('NATS_URL is required for context soak')
    }
    return null
  }

  try {
    const result = await runCommand('codex-nats-soak', [], { cwd: process.env.WORKTREE })
    if (result.exitCode !== 0) {
      const message = result.stderr.trim() || result.stdout.trim() || 'codex-nats-soak failed'
      if (required) {
        throw new Error(message)
      }
      logger.warn(`NATS context soak failed: ${message}`)
      return null
    }

    const raw = await readFile(outputPath, 'utf8')
    if (!raw.trim()) return null
    const parsed = JSON.parse(raw) as NatsContextPayload
    return parsed
  } catch (error) {
    if (required) {
      throw error
    }
    logger.warn('NATS context soak failed', error)
    return null
  }
}

const fetchJangarMemories = async ({
  logger,
  required,
  namespace,
  query,
  limit,
}: {
  logger: CodexLogger
  required: boolean
  namespace: string
  query: string
  limit: number
}): Promise<MemoryContextPayload | null> => {
  const baseUrl = sanitizeNullableString(process.env.JANGAR_BASE_URL ?? '')
  if (!baseUrl) {
    if (required) {
      throw new Error('JANGAR_BASE_URL is required for memory soak')
    }
    return null
  }

  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/api/memories`)
  url.searchParams.set('namespace', namespace)
  url.searchParams.set('query', query)
  url.searchParams.set('limit', String(limit))

  const maxAttempts = 3
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url.toString())
      if (!response.ok) {
        const message = await response.text()
        throw new Error(`Memory fetch failed (${response.status}): ${message}`)
      }
      const payload = (await response.json()) as { memories?: MemoryRecord[] }
      const memories = Array.isArray(payload.memories) ? payload.memories : []
      return {
        fetched: memories.length,
        query,
        namespace,
        memories,
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Memory fetch failed')
      logger.warn(`Jangar memory fetch failed (attempt ${attempt}/${maxAttempts})`, lastError)
      if (attempt < maxAttempts) {
        await sleep(750 * attempt)
      }
    }
  }

  if (required && lastError) {
    throw lastError
  }
  return null
}

const publishNatsEvent = async (
  logger: CodexLogger,
  input: { kind: string; content: string; attrs?: Record<string, unknown> },
) => {
  if (!process.env.NATS_URL) return
  const args = ['--kind', input.kind, '--content', input.content, '--channel', 'general', '--publish-general']
  if (input.attrs && Object.keys(input.attrs).length > 0) {
    args.push('--attrs-json', JSON.stringify(input.attrs))
  }
  try {
    await runCommand('codex-nats-publish', args)
  } catch (error) {
    logger.warn('Failed to publish NATS event', error)
  }
}

const enrichRunNatsAttrs = (
  attrs: Record<string, unknown>,
  requirementMetadata?: RequirementMetadata,
): Record<string, unknown> => {
  if (!requirementMetadata) {
    return attrs
  }
  if (requirementMetadata.workerId) {
    attrs.swarmAgentWorkerId = requirementMetadata.workerId
  }
  if (requirementMetadata.workerIdentity) {
    attrs.swarmAgentIdentity = requirementMetadata.workerIdentity
  }
  if (requirementMetadata.workerRole) {
    attrs.swarmAgentRole = requirementMetadata.workerRole
  }
  if (requirementMetadata.id) {
    attrs.swarmRequirementId = requirementMetadata.id
  }
  if (requirementMetadata.signal) {
    attrs.swarmRequirementSignal = requirementMetadata.signal
  }
  if (requirementMetadata.source) {
    attrs.swarmRequirementSource = requirementMetadata.source
  }
  if (requirementMetadata.target) {
    attrs.swarmRequirementTarget = requirementMetadata.target
  }
  if (requirementMetadata.channel) {
    attrs.swarmRequirementChannel = requirementMetadata.channel
  }
  if (requirementMetadata.description) {
    attrs.swarmRequirementDescription = requirementMetadata.description
  }
  if (requirementMetadata.objective) {
    attrs.swarmRequirementObjective = requirementMetadata.objective
  }
  if (requirementMetadata.payload) {
    attrs.swarmRequirementPayload = requirementMetadata.payload
  }
  if (requirementMetadata.payloadBytes) {
    attrs.swarmRequirementPayloadBytes = requirementMetadata.payloadBytes
  }
  if (typeof requirementMetadata.payloadTruncated === 'boolean') {
    attrs.swarmRequirementPayloadTruncated = requirementMetadata.payloadTruncated
  }
  return attrs
}

interface CaptureImplementationArtifactsOptions {
  worktree: string
  archivePath: string
  patchPath: string
  statusPath: string
  manifestPath: string
  jsonEventsPath?: string
  resumeMetadataPath: string
  baseRef?: string | null
  repository: string
  issueNumber: string
  prompt: string
  sessionId?: string
  resumedSessionId?: string
  markForResume: boolean
  logger: CodexLogger
}

interface ImplementationManifest {
  version: number
  generatedAt: string
  worktree: string
  repository: string
  issueNumber: string
  issue_number?: string
  prompt: string
  commitSha: string | null
  commit_sha?: string | null
  sessionId?: string
  session_id?: string
  trackedFiles: string[]
  deletedFiles: string[]
}

interface ResumeMetadataFile extends ImplementationManifest {
  resumedFromSessionId?: string
  archivePath: string
  patchPath: string
  statusPath: string
  state: 'pending' | 'cleared'
}

interface ResumeContext {
  path: string
  metadata: ResumeMetadataFile
}

const RESUME_METADATA_RELATIVE_PATH = ['.codex', 'implementation-resume.json']

const getResumeMetadataPath = (worktree: string) => join(worktree, ...RESUME_METADATA_RELATIVE_PATH)

const isSafeRelativePath = (filePath: string) => {
  return !!filePath && !filePath.startsWith('/') && !filePath.includes('..')
}

const isNotFoundError = (error: unknown): error is NodeJS.ErrnoException =>
  Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (error as { code?: string }).code === 'ENOENT',
  )

const extractSessionIdFromParsedEvent = (parsed: Record<string, unknown>): string | undefined => {
  const candidates = [
    parsed?.session instanceof Object ? (parsed.session as Record<string, unknown>).id : parsed?.session,
    parsed?.session_id,
    parsed?.sessionId,
    parsed?.conversation_id,
    parsed?.conversationId,
    parsed?.item instanceof Object && 'session' in (parsed.item as object)
      ? ((parsed.item as Record<string, unknown>).session as Record<string, unknown> | undefined)?.id
      : undefined,
    parsed?.item instanceof Object ? (parsed.item as Record<string, unknown>).session_id : undefined,
    parsed?.item instanceof Object ? (parsed.item as Record<string, unknown>).sessionId : undefined,
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim()
    }
  }
  return undefined
}

const extractSessionIdFromEvents = async (eventsPath: string | undefined, logger: CodexLogger) => {
  if (!eventsPath) {
    return undefined
  }

  try {
    const raw = await readFile(eventsPath, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) {
        continue
      }
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>
        const sessionId = extractSessionIdFromParsedEvent(parsed)
        if (sessionId) {
          return sessionId
        }
      } catch (error) {
        logger.warn('Failed to parse Codex events while extracting session id', error)
      }
    }
  } catch (error) {
    logger.warn(`Unable to read Codex events at ${eventsPath} while extracting session id`, error)
  }

  return undefined
}

const normalizeIssueNumber = (value: string | number) => String(value)

const parseOptionalInt = (value: string | number | null | undefined) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value)
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

const parsePositiveIntEnv = (value: string | undefined, fallback: number) => {
  if (!value || value.trim().length === 0) {
    return fallback
  }
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return parsed
}

const fitPromptToBudget = ({
  prompt,
  maxChars,
  logger,
  label,
}: {
  prompt: string
  maxChars: number
  logger: CodexLogger
  label: string
}) => {
  if (prompt.length <= maxChars) {
    return prompt
  }
  const marker = '\n\n...[prompt truncated to fit execution budget]...\n\n'
  if (maxChars <= marker.length + 2) {
    const hardTrimmed = prompt.slice(0, maxChars)
    logger.warn(`Prompt exceeded ${label} budget and was hard-trimmed`, {
      originalChars: prompt.length,
      truncatedChars: hardTrimmed.length,
      maxChars,
    })
    return hardTrimmed
  }

  const remainingChars = maxChars - marker.length
  const headChars = Math.max(1, Math.floor(remainingChars * 0.75))
  const tailChars = Math.max(1, remainingChars - headChars)
  const trimmed = `${prompt.slice(0, headChars)}${marker}${prompt.slice(-tailChars)}`
  logger.warn(`Prompt exceeded ${label} budget and was truncated`, {
    originalChars: prompt.length,
    truncatedChars: trimmed.length,
    maxChars,
  })
  return trimmed
}

const buildContextWindowRecoveryPrompt = ({
  repository,
  issueNumber,
  stage,
  baseBranch,
  headBranch,
  lane,
  objective,
}: {
  repository: string
  issueNumber: string
  stage: string
  baseBranch: string
  headBranch: string
  lane: SwarmExecutionLane
  objective?: string
}) => {
  const laneReminders = buildLaneCompletionReminders(lane)
  const lines = [
    'Previous attempt failed because the model context window was exceeded.',
    'Restart cleanly from the current workspace state and finish this stage end-to-end.',
    `Repository: ${repository}`,
    `Issue: ${issueNumber}`,
    `Stage: ${stage}`,
    `Execution lane: ${lane}`,
    `Branch: ${headBranch} (base ${baseBranch})`,
    objective ? `Objective: ${objective}` : '',
    ...laneReminders,
    'Keep all command output concise (head/tail/snippets only).',
    'Do not paste long logs or large generated content into the response.',
    'If a long report file is required, keep it short and pragmatic.',
    'Preserve thread-aware, human teammate communication in Huly updates.',
  ]
  return lines.filter((line) => line.length > 0).join('\n')
}

const readResumeContext = async (path: string, logger: CodexLogger): Promise<ResumeContext | undefined> => {
  if (!(await pathExists(path))) {
    return undefined
  }
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as ResumeMetadataFile
    if (typeof parsed.version !== 'number' || parsed.version < 1) {
      logger.warn(`Unsupported implementation resume metadata version in ${path}`)
      return undefined
    }
    return { metadata: parsed, path }
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined
    }
    logger.warn(`Failed to parse implementation resume metadata at ${path}`, error)
    return undefined
  }
}

const loadResumeMetadata = async ({
  worktree,
  repository,
  issueNumber,
  logger,
}: {
  worktree: string
  repository: string
  issueNumber: string
  logger: CodexLogger
}): Promise<ResumeContext | undefined> => {
  const metadataPath = getResumeMetadataPath(worktree)
  const context = await readResumeContext(metadataPath, logger)
  if (!context) {
    return undefined
  }

  const normalizedIssue = normalizeIssueNumber(issueNumber)
  if (context.metadata.state !== 'pending') {
    return undefined
  }

  if (context.metadata.repository !== repository || context.metadata.issueNumber !== normalizedIssue) {
    logger.info(
      `Ignoring resume state for ${context.metadata.repository}#${context.metadata.issueNumber}; requested ${repository}#${normalizedIssue}`,
    )
    return undefined
  }

  return context
}

const ensureEmptyFile = async (path: string) => {
  if (await pathExists(path)) {
    return
  }
  await ensureFileDirectory(path)
  await writeFile(path, '', 'utf8')
}

const ensureNotifyPlaceholder = async (path: string, logger: CodexLogger) => {
  try {
    await ensureFileDirectory(path)
    await writeFile(path, '', { flag: 'a' })
  } catch (error) {
    logger.warn(`Failed to ensure notify placeholder at ${path}`, error)
  }
}
const extractArchiveTo = async (archivePath: string, destination: string) => {
  await new Promise<void>((resolve, reject) => {
    const tarProcess = spawnChild('tar', ['-xzf', archivePath, '-C', destination], {
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    tarProcess.on('error', (error) => reject(error))
    tarProcess.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`tar exited with status ${code}`))
      }
    })
  })
}

const applyResumeContext = async ({
  worktree,
  context,
  logger,
}: {
  worktree: string
  context: ResumeContext
  logger: CodexLogger
}) => {
  const archivePath = context.metadata.archivePath
  if (!archivePath || !(await pathExists(archivePath))) {
    logger.warn(`Implementation resume archive not found at ${archivePath}`)
    return false
  }

  let extractionRoot: string | undefined
  try {
    extractionRoot = await mkdtemp(join(tmpdir(), 'codex-impl-resume-'))
    await extractArchiveTo(archivePath, extractionRoot)

    const manifestPath = join(extractionRoot, 'metadata', 'manifest.json')
    let manifest: ImplementationManifest | undefined
    if (await pathExists(manifestPath)) {
      try {
        const manifestRaw = await readFile(manifestPath, 'utf8')
        manifest = JSON.parse(manifestRaw) as ImplementationManifest
      } catch (error) {
        logger.warn('Failed to parse implementation resume manifest; continuing with recorded metadata', error)
      }
    }

    const trackedFiles = new Set(context.metadata.trackedFiles ?? [])
    const deletedFiles = new Set(context.metadata.deletedFiles ?? [])

    if (manifest) {
      manifest.trackedFiles.forEach((file) => {
        trackedFiles.add(file)
      })
      manifest.deletedFiles.forEach((file) => {
        deletedFiles.add(file)
      })
    }

    const filesDir = join(extractionRoot, 'files')
    let copiedCount = 0

    for (const relativePath of trackedFiles) {
      if (!isSafeRelativePath(relativePath)) {
        logger.warn(`Skipping unsafe resume path '${relativePath}'`)
        continue
      }
      const sourcePath = join(filesDir, relativePath)
      if (!(await pathExists(sourcePath))) {
        logger.warn(`Resume archive missing file '${relativePath}'`)
        continue
      }
      const destinationPath = join(worktree, relativePath)
      await ensureFileDirectory(destinationPath)
      await rm(destinationPath, { force: true, recursive: true })
      try {
        const stats = await lstat(sourcePath)
        if (stats.isSymbolicLink()) {
          const linkTarget = await readlink(sourcePath)
          await symlink(linkTarget, destinationPath)
        } else if (stats.isFile()) {
          await copyFile(sourcePath, destinationPath)
        } else {
          logger.warn(`Skipping non-file path '${relativePath}' in resume archive`)
          continue
        }
      } catch (error) {
        logger.warn(`Failed to restore '${relativePath}' from resume archive`, error)
        continue
      }
      copiedCount += 1
    }

    let removedCount = 0
    for (const relativePath of deletedFiles) {
      if (!isSafeRelativePath(relativePath)) {
        logger.warn(`Skipping unsafe delete path '${relativePath}' in resume metadata`)
        continue
      }
      const targetPath = join(worktree, relativePath)
      try {
        await rm(targetPath, { force: true, recursive: true })
        removedCount += 1
      } catch (error) {
        logger.warn(`Failed to remove '${relativePath}' while applying resume metadata`, error)
      }
    }

    logger.info(
      `Restored implementation resume state with ${copiedCount} file(s) copied and ${removedCount} file(s) removed`,
    )
    return true
  } catch (error) {
    logger.error('Failed to apply implementation resume state', error)
    return false
  } finally {
    if (extractionRoot) {
      await rm(extractionRoot, { recursive: true, force: true })
    }
  }
}

const captureImplementationArtifacts = async ({
  worktree,
  archivePath,
  patchPath,
  statusPath,
  manifestPath,
  jsonEventsPath,
  resumeMetadataPath,
  baseRef,
  repository,
  issueNumber,
  prompt,
  sessionId,
  resumedSessionId,
  markForResume,
  logger,
}: CaptureImplementationArtifactsOptions) => {
  const cleanupBundle = async (bundleRoot: string) => {
    try {
      await rm(bundleRoot, { recursive: true, force: true })
    } catch (error) {
      logger.warn('Failed to clean up implementation artifact bundle directory', error)
    }
  }

  let bundleRoot: string | undefined

  try {
    bundleRoot = await mkdtemp(join(tmpdir(), 'codex-impl-artifacts-'))
    const metadataDir = join(bundleRoot, 'metadata')
    const filesDir = join(bundleRoot, 'files')
    await ensureFileDirectory(join(metadataDir, '.keep'))

    let statusContent = ''
    try {
      const statusResult = await runCommand('git', ['status', '--short', '--branch'], { cwd: worktree })
      if (statusResult.exitCode === 0) {
        statusContent = statusResult.stdout.trim()
      } else {
        statusContent = `git status failed (exit ${statusResult.exitCode}): ${statusResult.stderr.trim()}`
        logger.warn('git status failed while capturing implementation artifacts', statusResult.stderr.trim())
      }
    } catch (error) {
      statusContent = `git status failed: ${error instanceof Error ? error.message : String(error)}`
      logger.warn('git status threw while capturing implementation artifacts', error)
    }

    await ensureFileDirectory(statusPath)
    await writeFile(statusPath, `${statusContent}\n`, 'utf8')
    await ensureFileDirectory(join(metadataDir, 'git-status.txt'))
    await writeFile(join(metadataDir, 'git-status.txt'), `${statusContent}\n`, 'utf8')

    const diffSpec = baseRef ? `${baseRef}..HEAD` : 'HEAD'
    let diffContent = ''
    try {
      const diffResult = await runCommand('git', ['diff', '--binary', diffSpec], { cwd: worktree })
      if (diffResult.exitCode === 0) {
        diffContent = diffResult.stdout
      } else {
        diffContent = `git diff failed (exit ${diffResult.exitCode}): ${diffResult.stderr.trim()}`
        logger.warn('git diff failed while capturing implementation artifacts', diffResult.stderr.trim())
      }
    } catch (error) {
      diffContent = `git diff failed: ${error instanceof Error ? error.message : String(error)}`
      logger.warn('git diff threw while capturing implementation artifacts', error)
    }

    await ensureFileDirectory(patchPath)
    await writeFile(patchPath, diffContent, 'utf8')
    await ensureFileDirectory(join(metadataDir, 'git-diff.patch'))
    await writeFile(join(metadataDir, 'git-diff.patch'), diffContent, 'utf8')

    const trackedFiles = new Set<string>()
    const deletedFiles: string[] = []

    try {
      const trackedResult = await runCommand('git', ['diff', '--name-only', '--diff-filter=ACMRTUXB', diffSpec], {
        cwd: worktree,
      })
      if (trackedResult.exitCode === 0) {
        trackedResult.stdout
          .split('\n')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
          .forEach((entry) => {
            trackedFiles.add(entry)
          })
      } else {
        logger.warn('git diff --name-only failed while capturing implementation artifacts', trackedResult.stderr.trim())
      }
    } catch (error) {
      logger.warn('git diff --name-only threw while capturing implementation artifacts', error)
    }

    try {
      const deletedResult = await runCommand('git', ['diff', '--name-only', '--diff-filter=D', diffSpec], {
        cwd: worktree,
      })
      if (deletedResult.exitCode === 0) {
        deletedResult.stdout
          .split('\n')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
          .forEach((entry) => {
            deletedFiles.push(entry)
          })
      }
    } catch (error) {
      logger.warn('git diff --name-only for deletions threw while capturing implementation artifacts', error)
    }

    try {
      const untrackedResult = await runCommand('git', ['ls-files', '--others', '--exclude-standard'], {
        cwd: worktree,
      })
      if (untrackedResult.exitCode === 0) {
        untrackedResult.stdout
          .split('\n')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
          .forEach((entry) => {
            trackedFiles.add(entry)
          })
      } else {
        logger.warn('git ls-files failed while capturing implementation artifacts', untrackedResult.stderr.trim())
      }
    } catch (error) {
      logger.warn('git ls-files threw while capturing implementation artifacts', error)
    }

    let commitSha: string | null = null
    try {
      const commitResult = await runCommand('git', ['rev-parse', 'HEAD'], { cwd: worktree })
      if (commitResult.exitCode === 0) {
        commitSha = commitResult.stdout.trim() || null
      } else {
        logger.warn('git rev-parse HEAD failed while capturing implementation artifacts', commitResult.stderr.trim())
      }
    } catch (error) {
      logger.warn('git rev-parse HEAD threw while capturing implementation artifacts', error)
    }

    const resolvedSessionId = sessionId ?? (await extractSessionIdFromEvents(jsonEventsPath, logger))

    const manifest = {
      version: 1,
      generatedAt: new Date().toISOString(),
      worktree,
      repository,
      issueNumber,
      issue_number: issueNumber,
      prompt,
      commitSha,
      commit_sha: commitSha,
      sessionId: resolvedSessionId,
      session_id: resolvedSessionId,
      trackedFiles: Array.from(trackedFiles).sort(),
      deletedFiles: deletedFiles.sort(),
    } satisfies ImplementationManifest

    await ensureFileDirectory(join(metadataDir, 'manifest.json'))
    await writeFile(join(metadataDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    await ensureFileDirectory(manifestPath)
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

    for (const relativePath of trackedFiles) {
      const sourcePath = join(worktree, relativePath)
      const destinationPath = join(filesDir, relativePath)

      let stats: import('node:fs').Stats
      try {
        stats = await lstat(sourcePath)
      } catch {
        continue
      }

      if (!stats.isFile() && !stats.isSymbolicLink()) {
        continue
      }

      try {
        await ensureFileDirectory(destinationPath)
        await rm(destinationPath, { force: true })
        if (stats.isSymbolicLink()) {
          const linkTarget = await readlink(sourcePath)
          await symlink(linkTarget, destinationPath)
        } else {
          await copyFile(sourcePath, destinationPath)
        }
      } catch (error) {
        logger.warn(`Failed to copy changed path '${relativePath}' into artifact bundle`, error)
      }
    }

    await ensureFileDirectory(archivePath)
    const tarProcess = spawnChild('tar', ['-czf', archivePath, '-C', bundleRoot, '.'], {
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    const tarExit = await new Promise<number>((resolve, reject) => {
      tarProcess.on('error', (tarError) => {
        reject(tarError)
      })
      tarProcess.on('close', (code) => {
        resolve(code ?? -1)
      })
    })
    if (tarExit !== 0) {
      throw new Error(`tar exited with status ${tarExit}`)
    }

    const resumeMetadata: ResumeMetadataFile = {
      ...manifest,
      archivePath,
      patchPath,
      statusPath,
      state: markForResume ? 'pending' : 'cleared',
      resumedFromSessionId: resumedSessionId,
    }

    await ensureFileDirectory(resumeMetadataPath)
    await writeFile(resumeMetadataPath, JSON.stringify(resumeMetadata, null, 2), 'utf8')
  } catch (error) {
    logger.error('Failed to capture implementation change artifacts', error)
    try {
      await ensureFileDirectory(archivePath)
      await writeFile(
        archivePath,
        `Failed to capture implementation artifacts: ${error instanceof Error ? error.message : String(error)}\n`,
        'utf8',
      )
    } catch (writeError) {
      logger.error('Failed to write fallback implementation artifact payload', writeError)
    }
  } finally {
    if (bundleRoot) {
      await cleanupBundle(bundleRoot)
    }
  }
}

export const runCodexImplementation = async (eventPath: string) => {
  if (!(await pathExists(eventPath))) {
    throw new Error(`Event payload file not found at '${eventPath}'`)
  }

  const event = await readEventPayload(eventPath)
  const extractedRequirementMetadata = extractSwarmRequirementMetadata(event)
  const resolvedHulyChannel = resolveActiveHulyChannel(extractedRequirementMetadata)
  const requirementMetadata = {
    ...extractedRequirementMetadata,
    channel: extractedRequirementMetadata.channel ?? resolvedHulyChannel,
  }
  const basePrompt = event.prompt?.trim() ?? ''
  let prompt = buildCrossSwarmRequirementScopePrompt(basePrompt, requirementMetadata)
  const crossSwarmHulyChannel = resolveActiveHulyChannel(requirementMetadata)

  const repository = event.repository?.trim()
  if (!repository) {
    throw new Error('Missing repository metadata in event payload')
  }

  const issueNumberRaw = event.issueNumber
  const issueNumber = issueNumberRaw !== undefined && issueNumberRaw !== null ? String(issueNumberRaw) : ''
  if (!issueNumber) {
    throw new Error('Missing issue number metadata in event payload')
  }

  const rawStage = event.stage ?? process.env.CODEX_STAGE ?? 'implementation'
  const stage = normalizeStage(rawStage)
  const executionLane = resolveExecutionLane({ stage, requirementMetadata })
  const iteration = parseOptionalInt(event.iteration)
  const iterationCycle = parseOptionalInt(event.iterationCycle ?? event.iteration_cycle)
  const iterations = parseOptionalInt(event.iterations)

  const worktree = process.env.WORKTREE ?? '/workspace/lab'
  const defaultOutputPath = `${worktree}/.codex-implementation.log`
  const outputPath = process.env.OUTPUT_PATH ?? defaultOutputPath
  const jsonOutputPath = process.env.JSON_OUTPUT_PATH ?? `${worktree}/.codex-implementation-events.jsonl`
  const agentOutputPath = process.env.AGENT_OUTPUT_PATH ?? `${worktree}/.codex-implementation-agent.log`
  const runtimeLogPath = process.env.CODEX_RUNTIME_LOG_PATH ?? `${worktree}/.codex-implementation-runtime.log`
  const patchPath = process.env.IMPLEMENTATION_PATCH_PATH ?? `${worktree}/.codex-implementation.patch`
  const statusPath = process.env.IMPLEMENTATION_STATUS_PATH ?? `${worktree}/.codex-implementation-status.txt`
  const archivePath =
    process.env.IMPLEMENTATION_CHANGES_ARCHIVE_PATH ?? `${worktree}/.codex-implementation-changes.tar.gz`
  const notifyPath = process.env.IMPLEMENTATION_NOTIFY_PATH ?? `${worktree}/.codex-implementation-notify.json`
  const manifestPath =
    process.env.IMPLEMENTATION_CHANGES_MANIFEST_PATH ?? `${worktree}/.codex-implementation-changes-manifest.json`
  const headShaPath = process.env.CODEX_HEAD_SHA_PATH ?? `${worktree}/.codex-head-sha.txt`
  const commitShaPath = process.env.COMMIT_SHA_PATH ?? `${worktree}/.codex-commit-sha.txt`
  const prNumberPath = process.env.PR_NUMBER_PATH ?? `${worktree}/.codex-pr-number.txt`
  const prUrlPath = process.env.PR_URL_PATH ?? `${worktree}/.codex-pr-url.txt`
  const natsContextPath = process.env.NATS_CONTEXT_PATH ?? `${worktree}/.codex-nats-context.json`
  const resumeMetadataPath = getResumeMetadataPath(worktree)
  const lokiEndpoint =
    process.env.LGTM_LOKI_ENDPOINT ??
    'http://observability-loki-loki-distributed-gateway.observability.svc.cluster.local/loki/api/v1/push'
  const lokiTenant = process.env.LGTM_LOKI_TENANT
  const lokiBasicAuth = process.env.LGTM_LOKI_BASIC_AUTH

  const baseBranch = sanitizeNullableString(event.base) || process.env.BASE_BRANCH || 'main'
  const headBranch = sanitizeNullableString(event.head) || process.env.HEAD_BRANCH || ''

  if (!headBranch) {
    throw new Error('Missing head branch metadata in event payload')
  }

  const assertCommandSuccess = (result: CommandResult, description: string) => {
    if (result.exitCode !== 0) {
      const output = [result.stderr, result.stdout].filter(Boolean).join('\n').trim()
      throw new Error(`${description} failed (exit ${result.exitCode})${output ? `: ${output}` : ''}`)
    }
  }

  await ensureWorktreeCheckout({ worktree, repository, logger: consoleLogger })

  // Ensure worktree tracks the requested head branch (not just base).
  assertCommandSuccess(await runCommand('git', ['fetch', '--all', '--prune'], { cwd: worktree }), 'git fetch')

  const syncWorktreeToHead = async () => {
    const remoteHeadExists =
      (
        await runCommand('git', ['rev-parse', '--verify', '--quiet', `origin/${headBranch}`], {
          cwd: worktree,
        })
      ).exitCode === 0

    const checkoutResult = await runCommand('git', ['checkout', headBranch], { cwd: worktree })
    if (checkoutResult.exitCode !== 0) {
      const fromRef = remoteHeadExists ? `origin/${headBranch}` : `origin/${baseBranch}`
      assertCommandSuccess(
        await runCommand('git', ['checkout', '-B', headBranch, fromRef], { cwd: worktree }),
        'git checkout -B head',
      )
    } else {
      assertCommandSuccess(checkoutResult, 'git checkout head')
    }

    const candidateRefs = remoteHeadExists ? [`origin/${headBranch}`, `origin/${baseBranch}`] : [`origin/${baseBranch}`]

    const resetErrors: string[] = []
    for (const ref of candidateRefs) {
      const resetResult = await runCommand('git', ['reset', '--hard', ref], { cwd: worktree })
      if (resetResult.exitCode === 0) {
        assertCommandSuccess(resetResult, `git reset --hard ${ref}`)
        return
      }
      resetErrors.push(`reset ${ref} failed (exit ${resetResult.exitCode}) ${resetResult.stderr || resetResult.stdout}`)
    }

    throw new Error(`git reset --hard failed; attempts: ${resetErrors.join('; ')}`)
  }

  await syncWorktreeToHead()

  const planCommentId =
    event.planCommentId !== undefined && event.planCommentId !== null ? String(event.planCommentId) : ''
  const planCommentUrl = sanitizeNullableString(event.planCommentUrl)
  const planCommentBody = sanitizeNullableString(event.planCommentBody)
  const issueTitle = sanitizeNullableString(event.issueTitle ?? process.env.ISSUE_TITLE ?? '')

  if (!prompt) {
    throw new Error('Missing Codex prompt in event payload')
  }

  process.env.CODEX_PROMPT = prompt
  process.env.ISSUE_REPO = repository
  process.env.ISSUE_NUMBER = issueNumber
  process.env.CODEX_REPOSITORY = repository
  process.env.CODEX_ISSUE_NUMBER = issueNumber
  process.env.BASE_BRANCH = baseBranch
  process.env.HEAD_BRANCH = headBranch
  process.env.CODEX_BRANCH = headBranch
  process.env.PLAN_COMMENT_ID = planCommentId
  process.env.PLAN_COMMENT_URL = planCommentUrl
  process.env.PLAN_COMMENT_BODY = planCommentBody
  process.env.WORKTREE = worktree
  process.env.OUTPUT_PATH = outputPath
  process.env.ISSUE_TITLE = issueTitle
  process.env.CODEX_ITERATION = iteration !== null && iteration !== undefined ? String(iteration) : ''
  process.env.CODEX_ITERATION_CYCLE =
    iterationCycle !== null && iterationCycle !== undefined ? String(iterationCycle) : ''
  process.env.CODEX_ITERATIONS_COUNT = iterations !== null && iterations !== undefined ? String(iterations) : ''
  process.env.IMPLEMENTATION_PATCH_PATH = patchPath
  process.env.IMPLEMENTATION_STATUS_PATH = statusPath
  process.env.IMPLEMENTATION_CHANGES_ARCHIVE_PATH = archivePath
  process.env.IMPLEMENTATION_NOTIFY_PATH = notifyPath
  process.env.NATS_CONTEXT_PATH = natsContextPath
  process.env.COMMIT_SHA_PATH = commitShaPath
  process.env.PR_NUMBER_PATH = prNumberPath
  process.env.PR_URL_PATH = prUrlPath
  exportScalarEventParametersToEnv(event)

  process.env.CODEX_STAGE = stage
  process.env.RUST_LOG = process.env.RUST_LOG ?? 'codex_core=info,codex_exec=info'
  process.env.RUST_BACKTRACE = process.env.RUST_BACKTRACE ?? '1'

  const envChannelScript = sanitizeNullableString(process.env.CHANNEL_SCRIPT ?? '')
  const imageChannelScript = '/usr/local/bin/discord-channel.ts'
  const repoChannelScript = 'services/jangar/scripts/discord-channel.ts'
  const channelScript =
    envChannelScript || ((await pathExists(imageChannelScript)) ? imageChannelScript : repoChannelScript)
  const channelTimestamp = timestampUtc()
  const channelRunIdSource =
    process.env.CODEX_CHANNEL_RUN_ID ?? process.env.ARGO_WORKFLOW_NAME ?? process.env.ARGO_WORKFLOW_UID ?? randomRunId()
  const channelRunId = channelRunIdSource.slice(0, 24).toLowerCase()

  await initializeOutputFiles(
    [
      outputPath,
      jsonOutputPath,
      agentOutputPath,
      runtimeLogPath,
      notifyPath,
      patchPath,
      statusPath,
      archivePath,
      manifestPath,
      headShaPath,
      commitShaPath,
      prNumberPath,
      prUrlPath,
      natsContextPath,
    ],
    consoleLogger,
  )

  const logger = await createCodexLogger({
    logPath: runtimeLogPath,
    context: {
      stage,
      repository,
      issue: issueNumber,
      workflow: process.env.ARGO_WORKFLOW_NAME ?? undefined,
      namespace: process.env.ARGO_WORKFLOW_NAMESPACE ?? undefined,
      run_id: channelRunId || undefined,
    },
  })
  await postProgressComment({
    logger,
    repository,
    issueNumber,
    stage,
    headBranch,
    baseBranch,
    phase: 'started',
    requirementMetadata,
  })

  const hulyWorkerContext = resolveHulyWorkerContext(requirementMetadata)
  let hulyArtifacts: HulyRequirementArtifacts | undefined
  const hulyAccessMessage = `Hi team, I am starting ${stage} for ${repository}#${issueNumber} and will post progress here.`

  if (crossSwarmHulyChannel) {
    try {
      const listResult = await listChannelMessages({
        channel: crossSwarmHulyChannel,
        workerId: hulyWorkerContext.workerId,
        workerIdentity: hulyWorkerContext.workerIdentity,
        requireWorkerToken: true,
      })

      const accessResult = await verifyChatAccess({
        channel: crossSwarmHulyChannel,
        message: hulyAccessMessage,
        workerId: hulyWorkerContext.workerId,
        workerIdentity: hulyWorkerContext.workerIdentity,
        requireWorkerToken: true,
      })

      const actorId =
        normalizeNullableStringValue(accessResult.actorId) || normalizeNullableStringValue(accessResult.expectedActorId)
      const latestPeerMessage = resolveLatestPeerMessage(listResult, actorId ?? undefined)

      hulyArtifacts = {
        activeChannel: crossSwarmHulyChannel,
        actorId: actorId ?? undefined,
        latestPeerMessageId: latestPeerMessage?.messageId,
        latestPeerMessage: latestPeerMessage?.message,
        verification: accessResult,
        listMessages: listResult,
      }
    } catch (error) {
      logger.warn('Failed Huly cross-swarm initialization for implementation handoff', error)
      throw error
    }
  }

  const systemPromptPath = normalizeOptionalString(sanitizeNullableString(process.env.CODEX_SYSTEM_PROMPT_PATH))
  const payloadSystemPrompt = normalizeOptionalString(sanitizeNullableString(event.systemPrompt))
  const expectedSystemPromptHash = normalizeOptionalString(
    sanitizeNullableString(process.env.CODEX_SYSTEM_PROMPT_EXPECTED_HASH),
  )?.toLowerCase()
  const systemPromptRequired = parseBoolean(process.env.CODEX_SYSTEM_PROMPT_REQUIRED, Boolean(expectedSystemPromptHash))
  let systemPromptSource: 'path' | 'payload' | undefined
  let systemPrompt: string | undefined
  if (systemPromptPath && (await pathExists(systemPromptPath))) {
    try {
      const content = await readFile(systemPromptPath, 'utf8')
      if (content.trim().length > 0) {
        systemPromptSource = 'path'
        systemPrompt = content
      } else {
        logger.warn('System prompt file was empty; ignoring', { systemPromptPath })
      }
    } catch (error) {
      logger.warn('Failed to read system prompt file; ignoring', { systemPromptPath }, error)
    }
  }
  if (!systemPrompt && payloadSystemPrompt) {
    systemPromptSource = 'payload'
    systemPrompt = payloadSystemPrompt
  }
  const systemPromptHash = systemPrompt ? sha256Hex(systemPrompt) : undefined
  if (systemPromptRequired && !systemPrompt) {
    throw new Error(
      `System prompt is required but was not loaded (path=${systemPromptPath ?? 'unset'}, source=${payloadSystemPrompt ? 'payload-available' : 'none'})`,
    )
  }
  if (expectedSystemPromptHash) {
    if (!systemPromptHash) {
      throw new Error(
        `System prompt hash verification failed: expected ${expectedSystemPromptHash}, but no system prompt was loaded`,
      )
    }
    if (systemPromptHash.toLowerCase() !== expectedSystemPromptHash) {
      throw new Error(
        `System prompt hash mismatch: expected ${expectedSystemPromptHash}, got ${systemPromptHash.toLowerCase()}`,
      )
    }
  }
  if (systemPrompt && systemPromptHash) {
    logger.info('System prompt configured', {
      source: systemPromptSource,
      systemPromptLength: systemPrompt.length,
      systemPromptHash,
    })
  }

  const natsSoakRequired =
    (process.env.CODEX_NATS_SOAK_REQUIRED ?? 'true').trim().toLowerCase() !== 'false' &&
    (process.env.CODEX_NATS_SOAK_REQUIRED ?? 'true').trim() !== '0'

  const shouldRequireMemories = stage === 'implementation' && ((iteration ?? 1) >= 2 || (iterationCycle ?? 1) >= 2)
  const memoryNamespace = `codex:${repository}:${issueNumber}`
  const memoryQuery = `issue ${issueNumber} ${issueTitle || repository} codex run summary`
  const memorySoak = await fetchJangarMemories({
    logger,
    required: shouldRequireMemories,
    namespace: memoryNamespace,
    query: memoryQuery,
    limit: 12,
  })
  const memoryContextBlock = formatMemoryContextBlock(memorySoak)
  if (memoryContextBlock) {
    prompt = `${memoryContextBlock}\n\n${prompt}`
  }

  const natsContext = await fetchNatsContext({
    logger,
    required: natsSoakRequired,
    outputPath: natsContextPath,
  })
  const natsContextBlock = formatNatsContextBlock(natsContext)
  if (natsContextBlock) {
    prompt = `${natsContextBlock}\n\n${prompt}`
  }
  const maxPromptChars = parsePositiveIntEnv(process.env.CODEX_MAX_PROMPT_CHARS, DEFAULT_MAX_PROMPT_CHARS)
  prompt = fitPromptToBudget({
    prompt,
    maxChars: maxPromptChars,
    logger,
    label: 'initial',
  })

  await ensureEmptyFile(outputPath)
  await ensureEmptyFile(jsonOutputPath)
  await ensureEmptyFile(agentOutputPath)
  await ensureEmptyFile(runtimeLogPath)

  if (process.env.CODEX_SKIP_RUN_STARTED !== '1') {
    const attrs = enrichRunNatsAttrs({ stage, iteration, iterationCycle }, requirementMetadata)
    if (systemPromptHash) {
      attrs.systemPromptHash = systemPromptHash
    }
    await publishNatsEvent(logger, {
      kind: 'run-started',
      content: `${stage} started`,
      attrs,
    })
  }

  const normalizedIssueNumber = issueNumber
  const disableResume = parseBoolean(process.env.CODEX_DISABLE_RESUME, false)
  const supportsResume = stage === 'implementation' && !disableResume
  let resumeContext: ResumeContext | undefined
  let resumeSessionId: string | undefined
  let capturedSessionId: string | undefined
  let runSucceeded = false
  let lastAssistantMessage: string | null = null
  let prUrl: string | null = null

  try {
    if (supportsResume) {
      resumeContext = await loadResumeMetadata({
        worktree,
        repository,
        issueNumber: normalizedIssueNumber,
        logger,
      })

      if (resumeContext) {
        logger.info(
          `Found pending resume state from ${resumeContext.metadata.generatedAt}; attempting to restore implementation changes`,
        )
        const applied = await applyResumeContext({ worktree, context: resumeContext, logger })
        if (applied) {
          if (resumeContext.metadata.sessionId && resumeContext.metadata.sessionId.trim().length > 0) {
            resumeSessionId = resumeContext.metadata.sessionId.trim()
            logger.info(`Resuming Codex session ${resumeSessionId}`)
          } else {
            resumeSessionId = '--last'
            logger.warn('Resume metadata missing session id; falling back to --last to resume the latest Codex session')
          }
        } else {
          logger.warn('Failed to restore resume archive; proceeding with a fresh Codex session')
        }
      }
    }

    capturedSessionId = resumeSessionId

    let discordChannelCommand: string[] | undefined
    const discordToken = process.env.DISCORD_BOT_TOKEN ?? ''
    const discordGuild = process.env.DISCORD_GUILD_ID ?? ''
    const discordScriptExists = await pathExists(channelScript)

    if (discordToken && discordGuild && discordScriptExists) {
      const args = ['--stage', stage, '--repo', repository, '--issue', issueNumber, '--timestamp', channelTimestamp]
      if (channelRunId) {
        args.push('--run-id', channelRunId)
      }
      if (issueTitle) {
        args.push('--title', issueTitle)
      }
      if (process.env.DISCORD_CHANNEL_DRY_RUN === '1') {
        args.push('--dry-run')
      }
      try {
        discordChannelCommand = await buildDiscordChannelCommand(channelScript, args)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn(`Discord channel disabled: ${message}`)
      }
    } else {
      logger.warn('Discord channel disabled: missing credentials or channel script')
    }

    if (resumeSessionId) {
      logger.info(`Running Codex ${stage} for ${repository}#${issueNumber} (resume mode)`)
    } else {
      logger.info(`Running Codex ${stage} for ${repository}#${issueNumber}`)
    }

    const maxSessionAttempts = parsePositiveIntEnv(process.env.CODEX_MAX_SESSION_ATTEMPTS, 3)
    let sessionResult: RunCodexSessionResult = { agentMessages: [], sessionId: undefined, exitCode: 0 }
    const primaryModel = normalizeOptionalString(sanitizeNullableString(process.env.CODEX_MODEL))
    const modelFallbackQueue = parseModelCandidates(process.env.CODEX_MODEL_FALLBACKS ?? '').filter(
      (candidate) => candidate !== primaryModel,
    )
    const runSession = async (sessionPrompt: string) => {
      return await runCodexSession({
        stage: stage as Parameters<typeof runCodexSession>[0]['stage'],
        prompt: sessionPrompt,
        systemPrompt,
        outputPath,
        jsonOutputPath,
        agentOutputPath,
        resumeSessionId,
        logger,
        discordChannel: discordChannelCommand
          ? {
              command: discordChannelCommand,
              onError: (error) => logger.error(`Discord channel failed: ${error.message}`),
            }
          : undefined,
      })
    }

    let sessionPrompt = prompt
    const contextWindowPattern =
      /ran out of room in the model'?s context window|context window|maximum context length|context_length_exceeded/i
    const isContextWindowError = (value: string | undefined) => {
      if (!value) {
        return false
      }
      return contextWindowPattern.test(value)
    }
    const recoveryObjective = requirementMetadata.objective ?? event.objective ?? event.swarmRequirementObjective
    for (let attempt = 1; attempt <= maxSessionAttempts; attempt += 1) {
      try {
        sessionResult = await runSession(sessionPrompt)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (detectProviderThrottle(message) && modelFallbackQueue.length > 0 && attempt < maxSessionAttempts) {
          const nextModel = modelFallbackQueue.shift()
          if (nextModel) {
            logger.warn(
              `Codex session attempt ${attempt}/${maxSessionAttempts} hit transient provider throttling; switching model from ${process.env.CODEX_MODEL ?? 'unset'} to ${nextModel}`,
            )
            process.env.CODEX_MODEL = nextModel
            resumeSessionId = undefined
            capturedSessionId = undefined
            sessionPrompt = fitPromptToBudget({
              prompt: buildProviderFallbackPrompt({
                repository,
                issueNumber,
                stage,
                lane: executionLane,
                objective: recoveryObjective,
              }),
              maxChars: maxPromptChars,
              logger,
              label: 'provider-fallback-recovery',
            })
            continue
          }
        }
        if (attempt >= maxSessionAttempts || !isContextWindowError(message)) {
          throw error
        }
        logger.warn(
          `Codex session attempt ${attempt}/${maxSessionAttempts} failed with context-window exhaustion; restarting fresh session`,
        )
        resumeSessionId = undefined
        capturedSessionId = undefined
        sessionPrompt = fitPromptToBudget({
          prompt: buildContextWindowRecoveryPrompt({
            repository,
            issueNumber,
            stage,
            baseBranch,
            headBranch,
            lane: executionLane,
            objective: recoveryObjective,
          }),
          maxChars: maxPromptChars,
          logger,
          label: 'context-window-recovery',
        })
        continue
      }
      const fallbackAssistantMessage = await readOptionalTextFile(outputPath, logger)
      lastAssistantMessage =
        sessionResult.agentMessages.length > 0
          ? sessionResult.agentMessages[sessionResult.agentMessages.length - 1]
          : fallbackAssistantMessage

      capturedSessionId =
        sessionResult.sessionId ?? resumeContext?.metadata.sessionId ?? capturedSessionId ?? resumeSessionId
      if (capturedSessionId) {
        logger.info(`Codex session id: ${capturedSessionId}`)
      }

      const forcedTermination = sessionResult.forcedTermination === true
      const contextWindowExceeded = sessionResult.contextWindowExceeded === true
      const exitCode = sessionResult.exitCode ?? 0
      const missingAssistantMessage = !lastAssistantMessage
      if (!forcedTermination && exitCode === 0 && !missingAssistantMessage) {
        break
      }

      const failureReasons: string[] = []
      if (forcedTermination) {
        failureReasons.push('forced termination')
      }
      if (exitCode !== 0) {
        failureReasons.push(`exit code ${exitCode}`)
      }
      if (missingAssistantMessage) {
        failureReasons.push('missing assistant final message')
      }
      if (contextWindowExceeded) {
        failureReasons.push('context window exceeded')
      }
      const failureReasonText = failureReasons.length > 0 ? failureReasons.join(', ') : 'incomplete session'

      if (detectProviderThrottle(lastAssistantMessage ?? undefined) && modelFallbackQueue.length > 0) {
        const nextModel = modelFallbackQueue.shift()
        if (nextModel) {
          logger.warn(
            `Codex session attempt ${attempt}/${maxSessionAttempts} produced transient provider throttle signals; switching model from ${process.env.CODEX_MODEL ?? 'unset'} to ${nextModel}`,
          )
          process.env.CODEX_MODEL = nextModel
          resumeSessionId = undefined
          capturedSessionId = undefined
          sessionPrompt = fitPromptToBudget({
            prompt: buildProviderFallbackPrompt({
              repository,
              issueNumber,
              stage,
              lane: executionLane,
              objective: recoveryObjective,
            }),
            maxChars: maxPromptChars,
            logger,
            label: 'provider-fallback-recovery',
          })
          continue
        }
      }

      if (attempt >= maxSessionAttempts) {
        throw new Error(
          `Codex session ended without a complete final response after ${maxSessionAttempts} attempt(s): ${failureReasonText}`,
        )
      }

      if (contextWindowExceeded) {
        logger.warn(
          `Codex session attempt ${attempt}/${maxSessionAttempts} hit context-window limits; restarting fresh session`,
        )
        resumeSessionId = undefined
        capturedSessionId = undefined
        sessionPrompt = fitPromptToBudget({
          prompt: buildContextWindowRecoveryPrompt({
            repository,
            issueNumber,
            stage,
            baseBranch,
            headBranch,
            lane: executionLane,
            objective: recoveryObjective,
          }),
          maxChars: maxPromptChars,
          logger,
          label: 'context-window-recovery',
        })
        continue
      }

      const resumeCandidate = sessionResult.sessionId ?? capturedSessionId ?? resumeSessionId
      resumeSessionId = resumeCandidate && resumeCandidate.trim().length > 0 ? resumeCandidate : '--last'
      logger.warn(
        `Codex session attempt ${attempt}/${maxSessionAttempts} ended incompletely (${failureReasonText}); resuming`,
      )
      sessionPrompt = [
        'Continue the previous Codex session for this same task.',
        'Do not restart from scratch.',
        'Use the current workspace state to finish the remaining required work end-to-end and provide the final response.',
      ].join('\n')
    }

    await copyAgentLogIfNeeded(outputPath, agentOutputPath)
    await pushCodexEventsToLoki({
      stage,
      endpoint: lokiEndpoint,
      jsonPath: jsonOutputPath,
      agentLogPath: agentOutputPath,
      runtimeLogPath,
      labels: {
        repository,
        issue: issueNumber,
        workflow: process.env.ARGO_WORKFLOW_NAME ?? undefined,
        namespace: process.env.ARGO_WORKFLOW_NAMESPACE ?? undefined,
        run_id: channelRunId || undefined,
      },
      tenant: lokiTenant,
      basicAuth: lokiBasicAuth,
      logger,
    })

    const logExcerpt = await collectLogExcerpts(
      {
        outputPath,
        jsonOutputPath,
        agentOutputPath,
        runtimeLogPath,
        statusPath,
      },
      logger,
    )

    const commitSha = await resolveHeadSha(worktree, logger)

    const prNumberRaw = await readOptionalTextFile(prNumberPath, logger)
    const prUrlRaw = await readOptionalTextFile(prUrlPath, logger)
    let prNumber = prNumberRaw ? parseOptionalPrNumber(prNumberRaw) : null
    prUrl = prUrlRaw ? prUrlRaw : null
    const pullRequestsEnabled = parseBoolean(process.env.VCS_PULL_REQUESTS_ENABLED, false)
    const requirePullRequestConfigured = parseBoolean(process.env.CODEX_REQUIRE_PULL_REQUEST, pullRequestsEnabled)
    const isReleaseLikeExecution = isReleaseManagerLikeExecution(requirementMetadata)
    const requirePullRequest = isReleaseLikeExecution ? false : requirePullRequestConfigured
    const pullRequestDiscoveryEnabled = parseBoolean(process.env.CODEX_PR_DISCOVERY_ENABLED, true)
    const shouldRecoverMissingPrMetadata = requirePullRequest && (!prUrl || !prNumber)
    const shouldRefreshReleasePrMetadata = isReleaseLikeExecution
    if (
      pullRequestDiscoveryEnabled &&
      stage === 'implementation' &&
      (shouldRecoverMissingPrMetadata || shouldRefreshReleasePrMetadata)
    ) {
      const discoveredPr = await discoverPullRequestMetadata({
        repository,
        headBranch,
        worktree,
        logger,
      })
      if (discoveredPr) {
        const nextPrNumber = shouldRefreshReleasePrMetadata
          ? (discoveredPr.number ?? prNumber)
          : (prNumber ?? discoveredPr.number)
        const nextPrUrl = shouldRefreshReleasePrMetadata ? (discoveredPr.url ?? prUrl) : (prUrl ?? discoveredPr.url)
        const metadataChanged = nextPrNumber !== prNumber || nextPrUrl !== prUrl
        prNumber = nextPrNumber
        prUrl = nextPrUrl
        if (metadataChanged) {
          await persistDiscoveredPullRequestMetadata({
            prNumber,
            prUrl,
            prNumberPath,
            prUrlPath,
            logger,
          })
        }
        logger.info(
          shouldRefreshReleasePrMetadata
            ? 'Refreshed pull request metadata from GitHub for release verification'
            : 'Recovered pull request metadata from GitHub',
          {
            prNumber,
            prUrl,
            repository,
            headBranch,
          },
        )
      }
    }
    const roleCompletionEvidence = await evaluateRoleCompletionEvidence({
      lane: executionLane,
      event,
      repository,
      prUrl,
      worktree,
      baseBranch,
      lastAssistantMessage,
      logger,
    })
    const requireArchitectMergeEvidence =
      executionLane === 'architect' && roleCompletionEvidence.changedFiles.length > 0
    const pullRequestPolicyDecision = Effect.runSync(
      evaluatePullRequestPolicy({
        stage,
        requirePullRequest,
        prUrl,
        swarmAgentRole: requirementMetadata.workerRole ?? null,
        swarmHumanName: requirementMetadata.workerHumanName ?? null,
        requireArchitectMergeEvidence,
        hasArchitectMergeEvidence: roleCompletionEvidence.architectMergeEvidence,
      }),
    )
    if (!pullRequestPolicyDecision.ok) {
      throw new Error(pullRequestPolicyDecision.message)
    }
    const shouldEnforceEngineerChecks = executionLane === 'engineer' && stage === 'implementation' && Boolean(prUrl)
    if (shouldEnforceEngineerChecks && !roleCompletionEvidence.engineerChecksGreen) {
      throw new Error('Engineer run completed without verified green required checks for the active pull request')
    }
    if (executionLane === 'release' && !roleCompletionEvidence.releaseMergeEvidence) {
      throw new Error('Release run completed without merge evidence (merged PR/commit required)')
    }
    if (executionLane === 'release' && !roleCompletionEvidence.releaseRolloutEvidence) {
      throw new Error('Release run completed without healthy rollout evidence')
    }
    const headSha = commitSha ?? null
    try {
      await ensureFileDirectory(headShaPath)
      await writeFile(headShaPath, headSha ?? '', 'utf8')
    } catch (error) {
      logger.warn('Failed to persist head sha output', error)
    }

    if (stage === 'implementation') {
      try {
        await ensureFileDirectory(commitShaPath)
        await writeFile(commitShaPath, commitSha ?? '', 'utf8')
      } catch (error) {
        logger.warn('Failed to persist commit sha output', error)
      }
    }

    console.log(`Codex execution logged to ${outputPath}`)
    try {
      const jsonStats = await stat(jsonOutputPath)
      if (jsonStats.size > 0) {
        console.log(`Codex JSON events stored at ${jsonOutputPath}`)
      }
    } catch {
      // ignore missing json log
    }

    const summary = extractSummary(lastAssistantMessage)
    const tests = extractTests(lastAssistantMessage)
    const gaps = extractKnownGaps(lastAssistantMessage)
    const hulyDecision = 'completed' as const
    const natsDecision = 'pass'

    if (hulyArtifacts && crossSwarmHulyChannel) {
      hulyArtifacts = await buildHulyArtifactsFromRun({
        artifacts: hulyArtifacts,
        logger,
        repository,
        issueNumber,
        requirementMetadata,
        stage,
        tests,
        gaps,
        prUrl,
        decision: hulyDecision,
        runSummary: summary,
        activeChannel: crossSwarmHulyChannel,
        workerContext: hulyWorkerContext,
        includeReplyMessage: true,
        latestPeerMessageId: hulyArtifacts.latestPeerMessageId,
        latestPeerMessage: hulyArtifacts.latestPeerMessage,
      })
    }
    const nextPrompt = 'None'
    await publishNatsEvent(logger, {
      kind: 'run-summary',
      content: summary ?? `${stage} run completed`,
      attrs: enrichRunNatsAttrs(
        {
          stage,
          decision: natsDecision,
          prUrl,
          ciUrl: null,
          iteration,
          iterationCycle,
        },
        requirementMetadata,
      ),
    })
    await publishNatsEvent(logger, {
      kind: 'run-gaps',
      content: gaps.length > 0 ? gaps.join('; ') : 'None',
      attrs: enrichRunNatsAttrs(
        {
          stage,
          missingItems: gaps,
          suggestedFixes: gaps.length > 0 ? gaps : [],
          iteration,
          iterationCycle,
        },
        requirementMetadata,
      ),
    })
    await publishNatsEvent(logger, {
      kind: 'run-next-prompt',
      content: nextPrompt ?? 'None',
      attrs: enrichRunNatsAttrs({ stage, decision: natsDecision, iteration, iterationCycle }, requirementMetadata),
    })
    await publishNatsEvent(logger, {
      kind: 'run-outcome',
      content: `${stage} completed`,
      attrs: enrichRunNatsAttrs(
        {
          stage,
          decision: natsDecision,
          prUrl,
          ciUrl: null,
          tests,
          iteration,
          iterationCycle,
        },
        requirementMetadata,
      ),
    })
    const notifyPayload = buildNotifyPayload({
      repository,
      issueNumber,
      baseBranch,
      headBranch,
      prompt,
      stage,
      outputPath,
      jsonOutputPath,
      agentOutputPath,
      runtimeLogPath,
      statusPath,
      patchPath,
      archivePath,
      notifyPath,
      manifestPath,
      headShaPath,
      commitShaPath,
      prNumberPath,
      prUrlPath,
      sessionId: capturedSessionId,
      lastAssistantMessage,
      logExcerpt,
      commitSha,
      headSha,
      prNumber,
      prUrl,
      contextSoak: natsContext,
      memorySoak,
      iteration,
      iterationCycle,
      iterations,
      requirementMetadata,
      hulyArtifacts,
    })
    try {
      await ensureFileDirectory(notifyPath)
      await writeFile(notifyPath, JSON.stringify(notifyPayload, null, 2), 'utf8')
    } catch (error) {
      logger.warn('Failed to persist notify payload for artifacts', error)
    }
    await postNotifyPayload(notifyPayload, logger)

    await postProgressComment({
      logger,
      repository,
      issueNumber,
      stage,
      headBranch,
      baseBranch,
      phase: 'completed',
      prUrl,
      lastAssistantMessage,
      requirementMetadata,
    })

    runSucceeded = true
    return {
      repository,
      issueNumber,
      outputPath,
      jsonOutputPath,
      agentOutputPath,
      patchPath,
      statusPath,
      archivePath,
      sessionId: capturedSessionId,
    }
  } finally {
    if (!runSucceeded) {
      if (crossSwarmHulyChannel && hulyArtifacts) {
        const summary = extractSummary(lastAssistantMessage)
        const tests = extractTests(lastAssistantMessage)
        const gaps = extractKnownGaps(lastAssistantMessage)
        try {
          hulyArtifacts = await buildHulyArtifactsFromRun({
            artifacts: hulyArtifacts,
            logger,
            repository,
            issueNumber,
            requirementMetadata,
            stage,
            tests,
            gaps,
            prUrl,
            decision: 'failed',
            runSummary: summary,
            activeChannel: crossSwarmHulyChannel,
            workerContext: hulyWorkerContext,
            includeReplyMessage: Boolean(hulyArtifacts.latestPeerMessageId && hulyArtifacts.latestPeerMessage),
            latestPeerMessageId: hulyArtifacts.latestPeerMessageId,
            latestPeerMessage: hulyArtifacts.latestPeerMessage,
          })
        } catch (error) {
          logger.warn('Failed to publish failure handoff artifacts to Huly', error)
        }
      }

      await postProgressComment({
        logger,
        repository,
        issueNumber,
        stage,
        headBranch,
        baseBranch,
        phase: 'failed',
        prUrl,
        lastAssistantMessage,
        requirementMetadata,
      })
      await publishNatsEvent(logger, {
        kind: 'run-gaps',
        content: 'Run failed before emitting gaps; inspect logs and artifacts.',
        attrs: enrichRunNatsAttrs(
          { stage, missingItems: ['unknown_failure'], suggestedFixes: [], iteration, iterationCycle },
          requirementMetadata,
        ),
      })
      await publishNatsEvent(logger, {
        kind: 'run-outcome',
        content: `${stage} failed`,
        attrs: enrichRunNatsAttrs({ stage, decision: 'fail', iteration, iterationCycle }, requirementMetadata),
      })
    }
    await ensureNotifyPlaceholder(notifyPath, logger)
    try {
      if (stage === 'implementation') {
        const baseRef = await resolveBaseRef(worktree, baseBranch, logger)
        await captureImplementationArtifacts({
          worktree,
          archivePath,
          patchPath,
          statusPath,
          manifestPath,
          jsonEventsPath: jsonOutputPath,
          resumeMetadataPath,
          baseRef,
          repository,
          issueNumber: normalizedIssueNumber,
          prompt,
          sessionId: capturedSessionId,
          resumedSessionId: resumeContext?.metadata.sessionId,
          markForResume: !runSucceeded,
          logger,
        })
      }
    } catch (error) {
      logger.error('Failed while finalizing implementation artifacts', error)
    }
    await logger.flush()
  }
}

await runCli(import.meta, async () => {
  const eventPath = process.argv[2]
  if (!eventPath) {
    throw new Error('Usage: codex-implement.ts <event-json-path>')
  }
  await runCodexImplementation(eventPath)
})
