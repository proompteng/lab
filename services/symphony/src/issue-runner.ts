import type { DynamicToolCallResponse, DynamicToolSpec } from '@proompteng/codex'
import { Context, Effect, Layer } from 'effect'

import { CodexProtocolError, ConfigError, toLogError, TrackerError, WorkspaceError, WorkflowError } from './errors'
import { CodexSessionService, type CodexEvent } from './codex-app-session'
import { TrackerService } from './linear-client'
import type { Issue } from './types'
import { normalizeState } from './utils'
import { WorkflowService } from './workflow'
import { WorkspaceService } from './workspace-manager'
import { renderPromptTemplate } from './template'
import type { Logger } from './logger'

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

export type IssueRunnerCallbacks = {
  onEvent: (event: CodexEvent) => Effect.Effect<void, never>
  onWorkspacePath: (workspacePath: string) => Effect.Effect<void, never>
}

export interface IssueRunnerServiceDefinition {
  readonly runAttempt: (
    issue: Issue,
    attempt: number | null,
    callbacks: IssueRunnerCallbacks,
  ) => Effect.Effect<string, WorkflowError | ConfigError | TrackerError | WorkspaceError | CodexProtocolError>
}

export class IssueRunnerService extends Context.Tag('symphony/IssueRunnerService')<
  IssueRunnerService,
  IssueRunnerServiceDefinition
>() {}

export const makeIssueRunnerLayer = (logger: Logger) =>
  Layer.effect(
    IssueRunnerService,
    Effect.gen(function* () {
      const workflow = yield* WorkflowService
      const tracker = yield* TrackerService
      const workspace = yield* WorkspaceService
      const codexSessions = yield* CodexSessionService
      const issueRunnerLogger = logger.child({ component: 'issue-runner' })

      const handleToolCall = (toolName: string, args: unknown): Effect.Effect<DynamicToolCallResponse, never> =>
        Effect.gen(function* () {
          if (toolName !== 'linear_graphql') {
            return {
              success: false,
              contentItems: [{ type: 'inputText', text: JSON.stringify({ error: 'unsupported_tool_call' }) }],
            } satisfies DynamicToolCallResponse
          }

          if (typeof args === 'string') {
            const response = yield* tracker.executeLinearGraphql(args).pipe(
              Effect.catchAll((error) =>
                Effect.succeed({
                  error: error.message,
                  code: error.code,
                }),
              ),
            )
            return {
              success: !('error' in response),
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

          const response = yield* tracker.executeLinearGraphql(query, variables).pipe(
            Effect.catchAll((error) =>
              Effect.succeed({
                error: error.message,
                code: error.code,
              }),
            ),
          )
          return {
            success: !('error' in response),
            contentItems: [{ type: 'inputText', text: JSON.stringify(response) }],
          } satisfies DynamicToolCallResponse
        })

      return {
        runAttempt: (issue, attempt, callbacks) =>
          Effect.scoped(
            Effect.gen(function* () {
              const { definition, config } = yield* workflow.current
              const runLogger = issueRunnerLogger.child({ issue_id: issue.id, issue_identifier: issue.identifier })
              const workspaceInfo = yield* workspace.createForIssue(issue.identifier)
              yield* callbacks.onWorkspacePath(workspaceInfo.path)
              let lastIssue = issue

              const dynamicTools =
                config.tracker.kind === 'linear' && config.tracker.apiKey ? [LINEAR_GRAPHQL_TOOL] : []

              const initialPrompt =
                definition.promptTemplate.trim().length > 0
                  ? renderPromptTemplate(definition.promptTemplate, { issue, attempt })
                  : FALLBACK_PROMPT

              const session = yield* codexSessions.createSession({
                command: config.codex.command,
                cwd: workspaceInfo.path,
                approvalPolicy: config.codex.approvalPolicy,
                threadSandbox: config.codex.threadSandbox,
                turnSandboxPolicy: config.codex.turnSandboxPolicy,
                readTimeoutMs: config.codex.readTimeoutMs,
                turnTimeoutMs: config.codex.turnTimeoutMs,
                title: `${issue.identifier}: ${issue.title}`,
                dynamicTools,
                logger: runLogger,
                onEvent: callbacks.onEvent,
                onToolCall: handleToolCall,
              })

              yield* workspace.runBeforeRun(workspaceInfo.path)

              const program = Effect.gen(function* () {
                for (let turnNumber = 1; turnNumber <= config.agent.maxTurns; turnNumber += 1) {
                  const prompt =
                    turnNumber === 1
                      ? initialPrompt
                      : buildContinuationPrompt(lastIssue, turnNumber, config.agent.maxTurns)
                  const outcome = yield* session.runTurn(prompt)
                  if (outcome.status !== 'completed') {
                    return yield* Effect.fail(
                      new CodexProtocolError(
                        'turn_failed',
                        `turn ${outcome.turnId} ended with status ${outcome.status}`,
                      ),
                    )
                  }

                  const refreshed = yield* tracker.fetchIssueStatesByIds([lastIssue.id])
                  if (refreshed.length === 0) {
                    break
                  }
                  lastIssue = refreshed[0]

                  const latestConfig = yield* workflow.config
                  const activeStates = new Set(latestConfig.tracker.activeStates.map((state) => normalizeState(state)))
                  if (!activeStates.has(normalizeState(lastIssue.state))) {
                    break
                  }
                }

                return workspaceInfo.path
              })

              return yield* program.pipe(
                Effect.ensuring(
                  workspace.runAfterRun(workspaceInfo.path).pipe(
                    Effect.catchAll((error) =>
                      Effect.sync(() => {
                        runLogger.log('warn', 'workspace_after_run_failed', toLogError(error))
                      }),
                    ),
                  ),
                ),
              )
            }),
          ),
      } satisfies IssueRunnerServiceDefinition
    }),
  )
