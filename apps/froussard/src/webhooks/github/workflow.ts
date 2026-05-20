import type { Effect as EffectType } from 'effect/Effect'
import type { WorkflowCommand } from '@/codex/workflow-machine'
import type { AppConfigService } from '@/effect/config'
import type { AppRuntime } from '@/effect/runtime'
import { type AppLogger, logger } from '@/logger'
import type { AgentRunSubmission, AgentRunSubmitter } from '@/services/agents'
import type { GithubService } from '@/services/github/service'
import type { GithubServiceDefinition } from '@/services/github/service.types'
import type { KafkaProducer } from '@/services/kafka'
import { CODEX_READY_COMMENT_MARKER } from './constants'

export type WorkflowStage = 'implementation'

type GithubRuntimeEnv = AppLogger | AppConfigService | GithubService | KafkaProducer

export interface WorkflowExecutionContext {
  runtime: AppRuntime
  githubService: GithubServiceDefinition
  runGithub: <A, E>(factory: () => EffectType<A, E, GithubRuntimeEnv>) => Promise<A>
  config: {
    github: {
      token: string | null
      apiBaseUrl: string
      userAgent: string
    }
  }
  deliveryId: string
  agentRunIdentifier?: string | null
  submitAgentRun: AgentRunSubmitter
}

export const executeWorkflowCommands = async (
  commands: WorkflowCommand[],
  context: WorkflowExecutionContext,
): Promise<{ stage?: WorkflowStage }> => {
  let stage: WorkflowStage | undefined

  for (const command of commands) {
    switch (command.type) {
      case 'submitImplementation': {
        stage = 'implementation'
        logger.info(
          { key: command.data.key, deliveryId: context.deliveryId },
          'submitting codex implementation AgentRun',
        )
        const submission = command.data.agentRun as AgentRunSubmission
        const result = await context.submitAgentRun(submission)
        if (!result.ok) {
          throw new Error(result.error ?? `Agents service rejected AgentRun submission with HTTP ${result.status}`)
        }
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
