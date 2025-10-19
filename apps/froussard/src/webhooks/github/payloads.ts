import { Timestamp } from '@bufbuild/protobuf'

import {
  CodexFailingCheck as GithubCodexFailingCheck,
  CodexReviewContext as GithubCodexReviewContext,
  CodexReviewThread as GithubCodexReviewThread,
  CodexTask as GithubCodexTaskMessage,
  CodexTaskStage,
} from '@/proto/github/v1/codex_task_pb'
import type { CodexTaskMessage } from '@/codex'

const toTimestamp = (value: string): Timestamp => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return Timestamp.fromDate(new Date())
  }
  return Timestamp.fromDate(date)
}

export const buildReviewContextProto = (context: CodexTaskMessage['reviewContext'] | undefined) => {
  if (!context) {
    return undefined
  }

  return new GithubCodexReviewContext({
    summary: context.summary,
    reviewThreads: (context.reviewThreads ?? []).map(
      (thread) =>
        new GithubCodexReviewThread({
          summary: thread.summary,
          url: thread.url,
          author: thread.author,
        }),
    ),
    failingChecks: (context.failingChecks ?? []).map(
      (check) =>
        new GithubCodexFailingCheck({
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

  return new GithubCodexTaskMessage({
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
