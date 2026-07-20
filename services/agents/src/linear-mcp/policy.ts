import { createHash } from 'node:crypto'

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import type { LinearPublicToolName } from './contract'
import type { LinearMcpRunIdentity } from './identity'
import {
  canonicalArgumentHash,
  type LinearMutationReceipt,
  type LinearMutationReceiptStore,
  type LinearMutationTool,
} from './receipts'
import type { LinearUpstream } from './upstream'

export class LinearMcpPolicyError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'agent_run_inactive'
      | 'argument_denied'
      | 'contract_drift'
      | 'indeterminate_write'
      | 'issue_mismatch'
      | 'label_revoked'
      | 'mutation_in_progress'
      | 'status_invalid'
      | 'upstream_error',
  ) {
    super(message)
    this.name = 'LinearMcpPolicyError'
  }
}

export type LinearMcpPolicyContext = {
  identity: LinearMcpRunIdentity
  revalidateIdentity: () => Promise<LinearMcpRunIdentity>
}

export type LinearMcpPolicyService = {
  call: (
    name: LinearPublicToolName,
    args: Record<string, unknown>,
    context: LinearMcpPolicyContext,
  ) => Promise<CallToolResult>
}

type LinearIssueSnapshot = {
  uuid: string | null
  identifier: string
  team: string
  labels: string[]
  status: string | null
}

type LinearStatus = { id: string | null; name: string }

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const asRecord = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

const asString = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)

const nestedString = (value: Record<string, unknown>, paths: string[][]) => {
  for (const path of paths) {
    let cursor: unknown = value
    for (const key of path) {
      cursor = asRecord(cursor)?.[key]
    }
    const text = asString(cursor)
    if (text) return text
  }
  return null
}

const parseTextJson = (text: string) => {
  if (text.length > 2 * 1024 * 1024) return null
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return null
  }
}

const resultValues = (result: CallToolResult) => {
  const values: unknown[] = []
  if (result.structuredContent) values.push(result.structuredContent)
  for (const item of result.content) {
    if (item.type === 'text') {
      const parsed = parseTextJson(item.text)
      if (parsed != null) values.push(parsed)
    }
  }
  return values
}

const collectRecords = (value: unknown, limit = 500) => {
  const records: Record<string, unknown>[] = []
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  const visited = new Set<unknown>()
  while (pending.length > 0 && records.length < limit) {
    const entry = pending.shift()!
    if (!entry.value || typeof entry.value !== 'object' || entry.depth > 8 || visited.has(entry.value)) continue
    visited.add(entry.value)
    if (Array.isArray(entry.value)) {
      for (const item of entry.value) pending.push({ value: item, depth: entry.depth + 1 })
      continue
    }
    const record = entry.value as Record<string, unknown>
    records.push(record)
    for (const item of Object.values(record)) pending.push({ value: item, depth: entry.depth + 1 })
  }
  return records
}

const extractIssueSnapshot = (result: CallToolResult, expectedIdentifier: string): LinearIssueSnapshot => {
  const records = resultValues(result).flatMap((value) => collectRecords(value))
  const normalizedExpected = expectedIdentifier.toLowerCase()
  const candidates = records.filter((record) => {
    if (asString(record.identifier)) return true
    const id = asString(record.id)
    if (!id || UUID_PATTERN.test(id)) return false
    return Boolean(asString(record.title) || record.team || asString(record.teamId) || Array.isArray(record.labels))
  })
  const issue =
    candidates.find((record) => {
      const identifier = asString(record.identifier) ?? asString(record.id)
      return identifier?.toLowerCase() === normalizedExpected
    }) ?? candidates[0]
  if (!issue)
    throw new LinearMcpPolicyError('Linear issue response did not contain a verifiable identity', 'upstream_error')
  const identifier = (asString(issue.identifier) ?? asString(issue.id))!
  const uuid = [asString(issue.uuid), asString(issue.issueUuid), asString(issue.id)].find((value): value is string =>
    Boolean(value && UUID_PATTERN.test(value)),
  )
  const team = nestedString(issue, [
    ['team', 'id'],
    ['teamId'],
    ['team', 'key'],
    ['team', 'name'],
    ['team'],
    ['teamIdentifier'],
  ])
  if (!team) throw new LinearMcpPolicyError('Linear issue response did not contain a team identity', 'upstream_error')
  const rawLabels = Array.isArray(issue.labels)
    ? issue.labels
    : Array.isArray(asRecord(issue.labels)?.nodes)
      ? (asRecord(issue.labels)?.nodes as unknown[])
      : []
  const labels = rawLabels
    .map((label) => (typeof label === 'string' ? label.trim() : asString(asRecord(label)?.name)))
    .filter((label): label is string => Boolean(label))
  const status = nestedString(issue, [['status', 'name'], ['state', 'name'], ['status'], ['state']])
  return { uuid: uuid ?? null, identifier, team, labels, status }
}

const extractStatuses = (result: CallToolResult): LinearStatus[] => {
  const records = resultValues(result).flatMap((value) => collectRecords(value))
  const statuses = records
    .map((record) => ({ id: asString(record.id), name: asString(record.name) }))
    .filter((status): status is LinearStatus => Boolean(status.name))
  const unique = new Map(statuses.map((status) => [status.id ?? status.name.toLowerCase(), status]))
  return [...unique.values()]
}

const assertSameIdentity = (expected: LinearMcpRunIdentity, actual: LinearMcpRunIdentity) => {
  if (
    actual.agentRunUid !== expected.agentRunUid ||
    actual.issueUuid !== expected.issueUuid ||
    actual.issueIdentifier.toLowerCase() !== expected.issueIdentifier.toLowerCase()
  ) {
    throw new LinearMcpPolicyError('AgentRun source identity changed', 'issue_mismatch')
  }
}

const verifyIssue = (identity: LinearMcpRunIdentity, issue: LinearIssueSnapshot) => {
  if (
    issue.identifier.toLowerCase() !== identity.issueIdentifier.toLowerCase() ||
    (issue.uuid !== null && issue.uuid.toLowerCase() !== identity.issueUuid.toLowerCase())
  ) {
    throw new LinearMcpPolicyError('Linear issue does not match the AgentRun source', 'issue_mismatch')
  }
}

const safeResultId = (result: CallToolResult) => {
  const records = resultValues(result).flatMap((value) => collectRecords(value, 100))
  for (const record of records) {
    const id = asString(record.id) ?? asString(record.identifier)
    if (id && /^[a-zA-Z0-9_-]{1,100}$/.test(id)) return id
  }
  return null
}

const receiptResult = (receipt: LinearMutationReceipt): CallToolResult => ({
  content: [
    {
      type: 'text',
      text: receipt.sanitized_result_id
        ? `Mutation already completed (${receipt.sanitized_result_id}).`
        : 'Mutation already completed.',
    },
  ],
  structuredContent: {
    receiptId: receipt.id,
    state: receipt.state,
    resultId: receipt.sanitized_result_id,
  },
})

const hashText = (value: string) => createHash('sha256').update(value).digest('hex')

const commentMatches = (result: CallToolResult, actorId: string, body: string, startedAt: Date | string | null) => {
  const startedMs = startedAt ? new Date(startedAt).getTime() : Number.NaN
  if (!Number.isFinite(startedMs)) return null
  const expectedBodyHash = hashText(body)
  const records = resultValues(result).flatMap((value) => collectRecords(value))
  for (const record of records) {
    const candidateBody = nestedString(record, [['body'], ['content'], ['text']])
    const candidateActor = nestedString(record, [
      ['author', 'id'],
      ['user', 'id'],
      ['creator', 'id'],
      ['actor', 'id'],
      ['authorId'],
      ['userId'],
      ['creatorId'],
    ])
    const createdAt = nestedString(record, [['createdAt'], ['created_at']])
    const createdMs = createdAt ? Date.parse(createdAt) : Number.NaN
    if (
      candidateBody &&
      candidateActor === actorId &&
      hashText(candidateBody) === expectedBodyHash &&
      Number.isFinite(createdMs) &&
      createdMs >= startedMs - 5000 &&
      createdMs <= Date.now() + 30_000
    ) {
      return asString(record.id)
    }
  }
  return null
}

const mutationHash = (identity: LinearMcpRunIdentity, tool: LinearMutationTool, value: string) =>
  canonicalArgumentHash({ issueUuid: identity.issueUuid, tool, value })

const errorCode = (error: unknown) => {
  if (error instanceof LinearMcpPolicyError) return error.code
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code
  return 'upstream_error'
}

export const createLinearMcpPolicyService = (options: {
  upstream: LinearUpstream
  receipts: LinearMutationReceiptStore
  triggerLabel: string
  actorId: string
  onPolicyDenial?: (code: string, tool: string) => void
  onUpstreamError?: (operation: string) => void
  onIndeterminateWrite?: (tool: string) => void
  inFlightGraceMs?: number
  now?: () => number
}): LinearMcpPolicyService => {
  const inFlightGraceMs = options.inFlightGraceMs ?? 60_000
  const now = options.now ?? Date.now

  const isRecentInFlight = (receipt: LinearMutationReceipt) => {
    const startedAt = receipt.started_at ? new Date(receipt.started_at).getTime() : Number.NaN
    return Number.isFinite(startedAt) && now() - startedAt < inFlightGraceMs
  }

  const getVerifiedIssue = async (identity: LinearMcpRunIdentity) => {
    const result = await options.upstream.getIssue(identity.issueUuid)
    const issue = extractIssueSnapshot(result, identity.issueIdentifier)
    verifyIssue(identity, issue)
    return { result, issue }
  }

  const revalidateMutation = async (context: LinearMcpPolicyContext) => {
    const freshIdentity = await context.revalidateIdentity()
    assertSameIdentity(context.identity, freshIdentity)
    const verified = await getVerifiedIssue(freshIdentity)
    if (!verified.issue.labels.some((label) => label.toLowerCase() === options.triggerLabel)) {
      throw new LinearMcpPolicyError('Linear issue no longer has the agentrun label', 'label_revoked')
    }
    return { identity: freshIdentity, ...verified }
  }

  const reconcile = async (
    receipt: LinearMutationReceipt,
    tool: LinearMutationTool,
    value: string,
    identity: LinearMcpRunIdentity,
  ) => {
    try {
      if (tool === 'update_issue') {
        const { issue } = await getVerifiedIssue(identity)
        if (issue.status?.toLowerCase() === value.toLowerCase()) {
          const resultId = issue.uuid ?? identity.issueUuid
          await options.receipts.succeed(receipt.id, resultId)
          return receiptResult({ ...receipt, state: 'succeeded', sanitized_result_id: resultId })
        }
      } else {
        const comments = await options.upstream.listComments(identity.issueUuid)
        const commentId = commentMatches(comments, options.actorId, value, receipt.started_at)
        if (commentId) {
          await options.receipts.succeed(receipt.id, commentId)
          return receiptResult({ ...receipt, state: 'succeeded', sanitized_result_id: commentId })
        }
      }
    } catch {
      // An inconclusive reconciliation remains indeterminate and must not trigger a blind retry.
    }
    await options.receipts.indeterminate(receipt.id, 'reconciliation_unproven')
    options.onIndeterminateWrite?.(tool)
    throw new LinearMcpPolicyError('previous Linear mutation outcome is indeterminate', 'indeterminate_write')
  }

  const mutate = async (
    tool: LinearMutationTool,
    value: string,
    context: LinearMcpPolicyContext,
    invoke: (identity: LinearMcpRunIdentity) => Promise<CallToolResult>,
  ) => {
    const verified = await revalidateMutation(context)
    const hash = mutationHash(
      verified.identity,
      tool,
      tool === 'create_comment' ? hashText(value) : value.toLowerCase(),
    )
    const reservation = await options.receipts.reserve({
      agentRunUid: verified.identity.agentRunUid,
      agentRunName: verified.identity.agentRunName,
      namespace: verified.identity.namespace,
      issueUuid: verified.identity.issueUuid,
      issueIdentifier: verified.identity.issueIdentifier,
      tool,
      canonicalArgumentHash: hash,
    })
    const receipt = reservation.receipt
    if (receipt.state === 'succeeded') return receiptResult(receipt)
    if (receipt.state === 'indeterminate') {
      throw new LinearMcpPolicyError('previous Linear mutation outcome is indeterminate', 'indeterminate_write')
    }
    if (receipt.state === 'in_flight') {
      if (isRecentInFlight(receipt)) {
        throw new LinearMcpPolicyError('the same Linear mutation is already in progress', 'mutation_in_progress')
      }
      return reconcile(receipt, tool, value, verified.identity)
    }

    const claimed = await options.receipts.claim(receipt.id)
    if (!claimed) {
      const current = await options.receipts.get(receipt.id)
      if (!current) throw new LinearMcpPolicyError('Linear mutation receipt was lost', 'upstream_error')
      if (current.state === 'succeeded') return receiptResult(current)
      if (current.state === 'in_flight') {
        throw new LinearMcpPolicyError('the same Linear mutation is already in progress', 'mutation_in_progress')
      }
      throw new LinearMcpPolicyError('previous Linear mutation outcome is indeterminate', 'indeterminate_write')
    }

    try {
      const result = await invoke(verified.identity)
      await options.receipts.succeed(claimed.id, safeResultId(result))
      return result
    } catch (error) {
      options.onUpstreamError?.(tool)
      try {
        return await reconcile(claimed, tool, value, verified.identity)
      } catch (reconciliationError) {
        if (reconciliationError instanceof LinearMcpPolicyError) throw reconciliationError
        await options.receipts.indeterminate(claimed.id, errorCode(error))
        options.onIndeterminateWrite?.(tool)
        throw new LinearMcpPolicyError('Linear mutation outcome is indeterminate', 'indeterminate_write')
      }
    }
  }

  return {
    call: async (name, args, context) => {
      try {
        if (name === 'get_issue') return (await getVerifiedIssue(context.identity)).result
        if (name === 'list_comments') {
          await getVerifiedIssue(context.identity)
          return options.upstream.listComments(context.identity.issueUuid)
        }
        if (name === 'list_issue_statuses') {
          const { issue } = await getVerifiedIssue(context.identity)
          return options.upstream.listIssueStatuses(issue.team)
        }
        if (name === 'create_comment') {
          const body = asString(args.body)
          if (!body) throw new LinearMcpPolicyError('comment body is required', 'argument_denied')
          return mutate('create_comment', body, context, (identity) =>
            options.upstream.createComment(identity.issueUuid, body),
          )
        }

        const requestedStatus = asString(args.status)
        if (!requestedStatus) throw new LinearMcpPolicyError('status is required', 'argument_denied')
        const verified = await revalidateMutation(context)
        const statusesResult = await options.upstream.listIssueStatuses(verified.issue.team)
        const status = extractStatuses(statusesResult).find(
          (candidate) =>
            candidate.name.toLowerCase() === requestedStatus.toLowerCase() ||
            candidate.id?.toLowerCase() === requestedStatus.toLowerCase(),
        )
        if (!status)
          throw new LinearMcpPolicyError('requested status is not valid for the issue workflow', 'status_invalid')
        return mutate('update_issue', status.name, context, (identity) =>
          options.upstream.updateIssueStatus(identity.issueUuid, status.name),
        )
      } catch (error) {
        if (error instanceof LinearMcpPolicyError) {
          if (error.code === 'upstream_error' || error.code === 'contract_drift') {
            options.onUpstreamError?.(name)
          } else {
            options.onPolicyDenial?.(error.code, name)
          }
          throw error
        }
        options.onUpstreamError?.(name)
        throw new LinearMcpPolicyError('Linear MCP upstream request failed', 'upstream_error')
      }
    },
  }
}

export const __test__ = {
  commentMatches,
  extractIssueSnapshot,
  extractStatuses,
  safeResultId,
}
