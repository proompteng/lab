import type { DynamicToolCallResponse, DynamicToolSpec } from '@proompteng/codex'

import { SymphonyError, toError } from './errors'
import type { Logger } from './logger'
import { renderPromptTemplate } from './template'
import type { Issue, SymphonyConfig, WorkflowDefinition } from './types'
import type { IssueTrackerClient } from './linear-client'
import { normalizeState } from './utils'
import { CodexAppSession, type CodexEvent } from './codex-app-session'
import { WorkspaceManager } from './workspace-manager'

const FALLBACK_PROMPT = 'You are working on an issue from Linear.'

const LINEAR_GRAPHQL_TOOL: DynamicToolSpec = {
  name: 'linear_graphql',
  description: 'Execute one Linear GraphQL operation using Symphony tracker credentials.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      variables: { type: 'object' },
    },
    required: ['query'],
    additionalProperties: true,
  },
}

const buildContinuationPrompt = (issue: Issue, turnNumber: number, maxTurns: number): string =>
  [
    `Continue working on issue ${issue.identifier}: ${issue.title}.`,
    `This is continuation turn ${turnNumber} of at most ${maxTurns} in the current worker session.`,
    'Do not restate the original task. Continue from thread history, re-check the repository state, and make the next highest-value progress.',
    'If the issue is already complete or blocked, leave a concise handoff in the tracker/tooling available to you and stop.',
  ].join('\n')

export class IssueRunner {
  private readonly configProvider: () => Promise<SymphonyConfig>
  private readonly workflowProvider: () => Promise<{ definition: WorkflowDefinition; config: SymphonyConfig }>
  private readonly tracker: IssueTrackerClient
  private readonly workspaceManager: WorkspaceManager
  private readonly logger: Logger

  constructor(options: {
    configProvider: () => Promise<SymphonyConfig>
    workflowProvider: () => Promise<{ definition: WorkflowDefinition; config: SymphonyConfig }>
    tracker: IssueTrackerClient
    workspaceManager: WorkspaceManager
    logger: Logger
  }) {
    this.configProvider = options.configProvider
    this.workflowProvider = options.workflowProvider
    this.tracker = options.tracker
    this.workspaceManager = options.workspaceManager
    this.logger = options.logger.child({ component: 'issue-runner' })
  }

  async runAttempt(
    issue: Issue,
    attempt: number | null,
    onEvent: (event: CodexEvent) => void,
    signal: AbortSignal,
  ): Promise<string> {
    const { definition, config } = await this.workflowProvider()
    const workspace = await this.workspaceManager.createForIssue(issue.identifier)
    let session: CodexAppSession | null = null
    let lastIssue = issue

    try {
      await this.workspaceManager.runBeforeRun(workspace.path)

      const initialPrompt =
        definition.promptTemplate.trim().length > 0
          ? renderPromptTemplate(definition.promptTemplate, { issue, attempt })
          : FALLBACK_PROMPT

      const dynamicTools = config.tracker.kind === 'linear' && config.tracker.apiKey ? [LINEAR_GRAPHQL_TOOL] : []

      session = new CodexAppSession({
        command: config.codex.command,
        cwd: workspace.path,
        approvalPolicy: config.codex.approvalPolicy,
        threadSandbox: config.codex.threadSandbox,
        turnSandboxPolicy: config.codex.turnSandboxPolicy,
        readTimeoutMs: config.codex.readTimeoutMs,
        turnTimeoutMs: config.codex.turnTimeoutMs,
        title: `${issue.identifier}: ${issue.title}`,
        dynamicTools,
        logger: this.logger.child({ issue_id: issue.id, issue_identifier: issue.identifier }),
        onEvent,
        onToolCall: async (toolName, args) => {
          if (toolName !== 'linear_graphql') {
            return {
              success: false,
              contentItems: [{ type: 'inputText', text: JSON.stringify({ error: 'unsupported_tool_call' }) }],
            } satisfies DynamicToolCallResponse
          }

          if (typeof args === 'string') {
            const response = await this.tracker.executeLinearGraphql(args)
            return {
              success: true,
              contentItems: [{ type: 'inputText', text: JSON.stringify(response) }],
            } satisfies DynamicToolCallResponse
          }

          const raw = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
          const query = typeof raw.query === 'string' ? raw.query : ''
          const variables =
            raw.variables && typeof raw.variables === 'object' ? (raw.variables as Record<string, unknown>) : {}
          if (query.trim().length === 0) {
            return {
              success: false,
              contentItems: [{ type: 'inputText', text: JSON.stringify({ error: 'invalid_query' }) }],
            } satisfies DynamicToolCallResponse
          }
          const response = await this.tracker.executeLinearGraphql(query, variables)
          return {
            success: true,
            contentItems: [{ type: 'inputText', text: JSON.stringify(response) }],
          } satisfies DynamicToolCallResponse
        },
      })

      for (let turnNumber = 1; turnNumber <= config.agent.maxTurns; turnNumber += 1) {
        if (signal.aborted) {
          throw new SymphonyError('worker_aborted', 'worker was aborted')
        }

        const prompt =
          turnNumber === 1 ? initialPrompt : buildContinuationPrompt(lastIssue, turnNumber, config.agent.maxTurns)
        const outcome = await session.runTurn(prompt)
        if (outcome.status !== 'completed') {
          throw new SymphonyError('turn_failed', `turn ${outcome.turnId} ended with status ${outcome.status}`)
        }

        const refreshed = await this.tracker.fetchIssueStatesByIds([lastIssue.id])
        if (refreshed.length === 0) {
          break
        }
        lastIssue = refreshed[0]
        const normalizedState = normalizeState(lastIssue.state)
        const activeStates = new Set(config.tracker.activeStates.map((state) => normalizeState(state)))
        if (!activeStates.has(normalizedState)) {
          break
        }
      }

      return workspace.path
    } catch (error) {
      if (signal.aborted) {
        throw new SymphonyError('worker_aborted', 'worker was aborted', error)
      }
      throw error
    } finally {
      session?.stop()
      try {
        await this.workspaceManager.runAfterRun(workspace.path)
      } catch (error) {
        this.logger.log('warn', 'workspace_after_run_failed', {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          error: toError(error).message,
        })
      }
    }
  }
}
