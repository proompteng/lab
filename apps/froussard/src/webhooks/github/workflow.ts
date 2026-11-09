import type { ApprovalCommand } from '@/approvals/contracts'
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
  enqueueApproval: (command: Pick<ApprovalCommand, 'repositoryFullName' | 'pullNumber'>) => Promise<void>
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
      default:
        break
    }
  }

  return { stage }
}
