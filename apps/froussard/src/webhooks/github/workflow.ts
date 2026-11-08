import type { Effect as EffectType } from 'effect/Effect'
import type { WorkflowCommand } from '@/codex/workflow-machine'
import type { AppConfigService } from '@/effect/config'
import type { AppRuntime } from '@/effect/runtime'
import { type AppLogger, logger } from '@/logger'
import type { AgentRunSubmission, AgentRunSubmitter } from '@/services/agents'
import type { GithubService } from '@/services/github/service'
import type { GithubServiceDefinition } from '@/services/github/service.types'
import type { KafkaProducer } from '@/services/kafka'

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
  receivedAt: string
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
      case 'approveReadyPullRequest': {
        const result = await context.runGithub(() =>
          context.githubService.approvePullRequest({
            repositoryFullName: command.data.repositoryFullName,
            pullNumber: command.data.pullNumber,
            headSha: command.data.headSha,
            body: command.data.body,
            token: context.config.github.token,
            apiBaseUrl: context.config.github.apiBaseUrl,
            userAgent: context.config.github.userAgent,
          }),
        )
        if (!result.ok) {
          logger.warn(
            {
              repository: command.data.repositoryFullName,
              pullNumber: command.data.pullNumber,
              reason: result.reason,
              status: result.status,
            },
            'ready approval was not submitted',
          )
          if (!['not-ready', 'head-changed', 'pending-review'].includes(result.reason)) {
            throw new Error(`GitHub approval failed: ${result.reason} (${result.status ?? 'no status'})`)
          }
        } else {
          logger.info(
            {
              repository: command.data.repositoryFullName,
              pullNumber: command.data.pullNumber,
              headSha: command.data.headSha,
              reviewUrl: result.reviewUrl,
            },
            'ready approval confirmed',
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
