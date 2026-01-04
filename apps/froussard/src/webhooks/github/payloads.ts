import { create } from '@bufbuild/protobuf'
import { timestampFromDate } from '@bufbuild/protobuf/wkt'
import type { CodexTaskMessage } from '@/codex'
import {
  CodexTaskStage,
  CodexIterationsPolicySchema as GithubCodexIterationsPolicySchema,
  type CodexTask as GithubCodexTaskMessage,
  CodexTaskSchema as GithubCodexTaskSchema,
} from '@/proto/proompteng/froussard/v1/codex_task_pb'

const toTimestamp = (value: string | undefined) => {
  if (!value) {
    return timestampFromDate(new Date())
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return timestampFromDate(new Date())
  }
  return timestampFromDate(date)
}

export const toCodexTaskProto = (message: CodexTaskMessage, deliveryId: string): GithubCodexTaskMessage => {
  const iterations = message.iterations
    ? create(GithubCodexIterationsPolicySchema, {
        mode: message.iterations.mode,
        count: message.iterations.count,
        min: message.iterations.min,
        max: message.iterations.max,
        stopOn: message.iterations.stopOn ?? [],
        reason: message.iterations.reason,
      })
    : undefined

  return create(GithubCodexTaskSchema, {
    stage: CodexTaskStage.IMPLEMENTATION,
    prompt: message.prompt,
    repository: message.repository,
    base: message.base,
    head: message.head,
    issueNumber: BigInt(message.issueNumber),
    issueUrl: message.issueUrl,
    issueTitle: message.issueTitle,
    issueBody: message.issueBody,
    sender: message.sender,
    issuedAt: toTimestamp(message.issuedAt),
    planCommentId: message.planCommentId !== undefined ? BigInt(message.planCommentId) : undefined,
    planCommentUrl: message.planCommentUrl,
    planCommentBody: message.planCommentBody,
    deliveryId,
    metadataVersion: message.metadataVersion,
    iterations,
    iteration: message.iteration,
    iterationCycle: message.iterationCycle,
    autonomous: message.autonomous,
  })
}
