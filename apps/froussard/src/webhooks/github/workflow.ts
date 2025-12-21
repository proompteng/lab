import { toBinary } from '@bufbuild/protobuf'
import type { Effect as EffectType } from 'effect/Effect'
import type { WorkflowCommand } from '@/codex/workflow-machine'
import type { AppRuntime } from '@/effect/runtime'
import { logger } from '@/logger'
import { CodexTaskSchema } from '@/proto/proompteng/froussard/v1/codex_task_pb'
import type { GithubServiceDefinition } from '@/services/github/service.types'
import { publishKafkaMessage } from '@/webhooks/utils'
import {
  CODEX_READY_COMMENT_MARKER,
  PROTO_CODEX_TASK_FULL_NAME,
  PROTO_CODEX_TASK_SCHEMA,
  PROTO_CONTENT_TYPE,
} from './constants'

export type WorkflowStage = 'implementation'

export interface WorkflowExecutionContext {
  runtime: AppRuntime
  githubService: GithubServiceDefinition
  runGithub: <R, E, A>(factory: () => EffectType<R, E, A>) => Promise<A>
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
      case 'publishImplementation': {
        stage = 'implementation'
        logger.info(
          { key: command.data.key, deliveryId: context.deliveryId },
          'publishing codex implementation message',
        )
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
            value: toBinary(CodexTaskSchema, command.data.structuredMessage),
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
      case 'postReadyComment': {
        logger.info(
          {
            deliveryId: context.deliveryId,
            repository: command.data.repositoryFullName,
            pullNumber: command.data.pullNumber,
          },
          'ensuring codex ready comment exists',
        )
        const lookup = await context.runGithub(() =>
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

        const readyResult = await context.runGithub(() =>
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
