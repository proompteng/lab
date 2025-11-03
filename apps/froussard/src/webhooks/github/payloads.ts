import { create } from '@bufbuild/protobuf'
import { timestampFromDate } from '@bufbuild/protobuf/wkt'
import type { CodexTaskMessage } from '@/codex'
import {
  CodexTaskStage,
  CodexFailingCheckSchema as GithubCodexFailingCheckSchema,
  CodexReviewContextSchema as GithubCodexReviewContextSchema,
  CodexReviewThreadSchema as GithubCodexReviewThreadSchema,
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

export const buildReviewContextProto = (context: CodexTaskMessage['reviewContext'] | undefined) => {
  if (!context) {
    return undefined
  }

  return create(GithubCodexReviewContextSchema, {
    summary: context.summary,
    reviewThreads: (context.reviewThreads ?? []).map((thread) =>
      create(GithubCodexReviewThreadSchema, {
        summary: thread.summary,
        url: thread.url,
        author: thread.author,
      }),
    ),
    failingChecks: (context.failingChecks ?? []).map((check) =>
      create(GithubCodexFailingCheckSchema, {
        name: check.name,
        conclusion: check.conclusion,
        url: check.url,
        details: check.details,
      }),
    ),
    additionalNotes: context.additionalNotes ?? [],
  })
}

export const toCodexTaskProto = (message: CodexTaskMessage, deliveryId: string): GithubCodexTaskMessage => {
  const protoStage =
    message.stage === 'planning'
      ? CodexTaskStage.PLANNING
      : message.stage === 'review'
        ? CodexTaskStage.REVIEW
        : CodexTaskStage.IMPLEMENTATION

  return create(GithubCodexTaskSchema, {
    stage: protoStage,
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
    reviewContext: buildReviewContextProto(message.reviewContext),
  })
}
