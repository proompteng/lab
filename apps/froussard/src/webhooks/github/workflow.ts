import type { AppRuntime } from '@/effect/runtime'
import type { GithubServiceDefinition } from '@/services/github'
import {
  CODEX_READY_COMMENT_MARKER,
  PROTO_CODEX_TASK_FULL_NAME,
  PROTO_CODEX_TASK_SCHEMA,
  PROTO_CONTENT_TYPE,
} from './constants'
import { publishKafkaMessage } from '@/webhooks/utils'
import { logger } from '@/logger'
import type { WorkflowCommand } from '@/codex/workflow-machine'

export type WorkflowStage = 'planning' | 'implementation' | 'review'

export interface WorkflowExecutionContext {
  runtime: AppRuntime
  githubService: GithubServiceDefinition
  config: {
    github: {
      token: string | null
      apiBaseUrl: string
      userAgent: string
    }
    topics: {
      codex: string
      codexStructured: string
    }
  }
  deliveryId: string
  workflowIdentifier?: string | null
}

export const executeWorkflowCommands = async (
  commands: WorkflowCommand[],
  context: WorkflowExecutionContext,
): Promise<{ stage?: WorkflowStage }> => {
  let stage: WorkflowStage | undefined

  for (const command of commands) {
    switch (command.type) {
      case 'publishPlanning': {
        stage = 'planning'
        await context.runtime.runPromise(
          publishKafkaMessage({
            topic: command.data.topics.codex,
            key: command.data.key,
            value: JSON.stringify(command.data.codexMessage),
            headers: {
              ...command.data.jsonHeaders,
              'x-codex-task-stage': 'planning',
            },
          }),
        )

        await context.runtime.runPromise(
          publishKafkaMessage({
            topic: command.data.topics.codexStructured,
            key: command.data.key,
            value: command.data.structuredMessage.toBinary(),
            headers: {
              ...command.data.structuredHeaders,
              'x-codex-task-stage': 'planning',
              'content-type': PROTO_CONTENT_TYPE,
              'x-protobuf-message': PROTO_CODEX_TASK_FULL_NAME,
              'x-protobuf-schema': PROTO_CODEX_TASK_SCHEMA,
            },
          }),
        )

        if (command.data.ack) {
          const ackResult = await context.runtime.runPromise(
            context.githubService.postIssueReaction({
              repositoryFullName: command.data.ack.repositoryFullName,
              issueNumber: command.data.ack.issueNumber,
              reactionContent: command.data.ack.reaction,
              token: context.config.github.token,
              apiBaseUrl: context.config.github.apiBaseUrl,
              userAgent: context.config.github.userAgent,
            }),
          )

          if (ackResult.ok) {
            logger.info(
              {
                repository: command.data.ack.repositoryFullName,
                issueNumber: command.data.ack.issueNumber,
                deliveryId: context.deliveryId,
                reaction: command.data.ack.reaction,
              },
              'acknowledged github issue',
            )
          }
        }
        break
      }
      case 'publishImplementation': {
        stage = 'implementation'
        await context.runtime.runPromise(
          publishKafkaMessage({
            topic: command.data.topics.codex,
            key: command.data.key,
            value: JSON.stringify(command.data.codexMessage),
            headers: {
              ...command.data.jsonHeaders,
              'x-codex-task-stage': 'implementation',
            },
          }),
        )

        await context.runtime.runPromise(
          publishKafkaMessage({
            topic: command.data.topics.codexStructured,
            key: command.data.key,
            value: command.data.structuredMessage.toBinary(),
            headers: {
              ...command.data.structuredHeaders,
              'x-codex-task-stage': 'implementation',
              'content-type': PROTO_CONTENT_TYPE,
              'x-protobuf-message': PROTO_CODEX_TASK_FULL_NAME,
              'x-protobuf-schema': PROTO_CODEX_TASK_SCHEMA,
            },
          }),
        )
        break
      }
      case 'publishReview': {
        stage = 'review'
        await context.runtime.runPromise(
          publishKafkaMessage({
            topic: command.data.topics.codex,
            key: command.data.key,
            value: JSON.stringify(command.data.codexMessage),
            headers: {
              ...command.data.jsonHeaders,
              'x-codex-task-stage': 'review',
            },
          }),
        )

        await context.runtime.runPromise(
          publishKafkaMessage({
            topic: command.data.topics.codexStructured,
            key: command.data.key,
            value: command.data.structuredMessage.toBinary(),
            headers: {
              ...command.data.structuredHeaders,
              'x-codex-task-stage': 'review',
              'content-type': PROTO_CONTENT_TYPE,
              'x-protobuf-message': PROTO_CODEX_TASK_FULL_NAME,
              'x-protobuf-schema': PROTO_CODEX_TASK_SCHEMA,
            },
          }),
        )
        break
      }
      case 'markReadyForReview': {
        const result = await context.runtime.runPromise(
          context.githubService.markPullRequestReadyForReview({
            repositoryFullName: command.data.repositoryFullName,
            pullNumber: command.data.pullNumber,
            token: context.config.github.token,
            apiBaseUrl: context.config.github.apiBaseUrl,
            userAgent: context.config.github.userAgent,
          }),
        )

        if (result.ok) {
          logger.info(
            {
              deliveryId: context.deliveryId,
              repository: command.data.repositoryFullName,
              pullNumber: command.data.pullNumber,
            },
            'marking codex pull request ready for review',
          )

          const commentResult = await context.runtime.runPromise(
            context.githubService.createPullRequestComment({
              repositoryFullName: command.data.repositoryFullName,
              pullNumber: command.data.pullNumber,
              body: command.data.commentBody,
              token: context.config.github.token,
              apiBaseUrl: context.config.github.apiBaseUrl,
              userAgent: context.config.github.userAgent,
            }),
          )

          if (!commentResult.ok) {
            logger.warn(
              {
                deliveryId: context.deliveryId,
                repository: command.data.repositoryFullName,
                pullNumber: command.data.pullNumber,
                reason: commentResult.reason,
                status: commentResult.status,
              },
              'failed to post codex review handoff comment',
            )
          }
        } else {
          logger.warn(
            {
              deliveryId: context.deliveryId,
              repository: command.data.repositoryFullName,
              pullNumber: command.data.pullNumber,
              reason: result.reason,
              status: result.status,
            },
            'failed to convert codex pull request to ready state',
          )
        }
        break
      }
      case 'postReadyComment': {
        const lookup = await context.runtime.runPromise(
          context.githubService.findLatestPlanComment({
            repositoryFullName: command.data.repositoryFullName,
            issueNumber: command.data.issueNumber,
            token: context.config.github.token,
            apiBaseUrl: context.config.github.apiBaseUrl,
            userAgent: context.config.github.userAgent,
            marker: command.data.marker ?? CODEX_READY_COMMENT_MARKER,
          }),
        )

        if (lookup.ok) {
          break
        }

        if (lookup.reason && lookup.reason !== 'not-found') {
          logger.warn(
            {
              deliveryId: context.deliveryId,
              repository: command.data.repositoryFullName,
              pullNumber: command.data.pullNumber,
              reason: lookup.reason,
              status: lookup.status,
            },
            'failed to look up codex ready-to-merge comment',
          )
          break
        }

        const readyResult = await context.runtime.runPromise(
          context.githubService.createPullRequestComment({
            repositoryFullName: command.data.repositoryFullName,
            pullNumber: command.data.pullNumber,
            body: command.data.body,
            token: context.config.github.token,
            apiBaseUrl: context.config.github.apiBaseUrl,
            userAgent: context.config.github.userAgent,
          }),
        )

        if (!readyResult.ok) {
          logger.warn(
            {
              deliveryId: context.deliveryId,
              repository: command.data.repositoryFullName,
              pullNumber: command.data.pullNumber,
              reason: readyResult.reason,
              status: readyResult.status,
            },
            'failed to post codex ready-to-merge comment',
          )
        }
        break
      }
      default:
        break
    }
  }

  return { stage }
}
