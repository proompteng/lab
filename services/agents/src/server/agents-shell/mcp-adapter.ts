import { createHash, randomUUID } from 'node:crypto'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js'
import { Context, Effect, Layer } from 'effect'
import * as ParseResult from 'effect/ParseResult'
import * as Schema from 'effect/Schema'

import { AuthChallengeError, buildBearerChallenge, requireScopes, type AuthContext } from './auth'
import { toolAuditContext } from './audit'
import { CONNECTOR_LINK_SCOPES } from './constants'
import type { AgentsShellConfig } from './config'
import { AgentsShellRuntimeError, errorMessage } from './errors'
import { effectSchemaToJsonSchema } from './json-schema'
import { errorResult } from './results'
import type { AgentsShellRunner } from './runner'

type OAuth2SecurityScheme = {
  type: 'oauth2'
  scopes: string[]
}

export type EffectToolContext = {
  config: AgentsShellConfig
  runner: AgentsShellRunner
  auth: AuthContext
  requestId: string
}

export class AgentsShellServices extends Context.Tag('agents-shell/Services')<
  AgentsShellServices,
  EffectToolContext
>() {}

export const makeAgentsShellServicesLayer = (context: EffectToolContext) => Layer.succeed(AgentsShellServices, context)

export type EffectTool<I = any, O = any> = {
  name: string
  title: string
  description: string
  inputSchema: Schema.Schema<I, any, never>
  outputSchema?: Schema.Schema<O, any, never>
  annotations: ToolAnnotations
  scopes: string[]
  securitySchemes: OAuth2SecurityScheme[]
  _meta: Record<string, unknown>
  handler: (input: I, context: EffectToolContext) => Effect.Effect<CallToolResult, unknown, AgentsShellServices>
}

export const toolSecurityMeta = (scopes: string[]) => {
  const requestedScopes = Array.from(new Set([...scopes, ...CONNECTOR_LINK_SCOPES]))
  const securitySchemes: OAuth2SecurityScheme[] = [
    {
      type: 'oauth2',
      scopes: requestedScopes,
    },
  ]
  return {
    securitySchemes,
    _meta: {
      securitySchemes,
      ui: { visibility: ['model'] },
      'openai/visibility': 'public',
      'openai/toolInvocation/invoking': 'Running tool',
      'openai/toolInvocation/invoked': 'Tool complete',
    },
  }
}

const formatParseError = (error: ParseResult.ParseError) => ParseResult.TreeFormatter.formatErrorSync(error)

const decodeInput = async <I>(tool: EffectTool<I>, value: unknown): Promise<I> =>
  Effect.runPromise(
    Schema.decodeUnknown(tool.inputSchema)(value).pipe(
      Effect.mapError(
        (error) =>
          new Error(`Input validation error: Invalid arguments for tool ${tool.name}: ${formatParseError(error)}`),
      ),
    ),
  )

const toolOutcome = (name: string | undefined, result: CallToolResult) => {
  if (result.isError) return 'error'
  if ((name === 'exec' || name === 'read') && result.structuredContent?.state === 'running') return 'running'
  if (name === 'read' || name === 'status' || name === 'cancel') return 'succeeded'
  return result.structuredContent?.ok === false ? 'failed' : 'succeeded'
}

const validateOutput = async (tool: EffectTool<any, any>, result: CallToolResult): Promise<CallToolResult> => {
  if (!tool.outputSchema || result.isError) return result
  if (!result.structuredContent) {
    return errorResult(
      `Output validation error: Tool ${tool.name} has an output schema but no structured content was provided`,
    )
  }
  try {
    await Effect.runPromise(
      Schema.decodeUnknown(tool.outputSchema)(result.structuredContent).pipe(
        Effect.mapError(
          (error) =>
            new Error(
              `Output validation error: Invalid structured content for tool ${tool.name}: ${formatParseError(error)}`,
            ),
        ),
      ),
    )
    return result
  } catch (error) {
    return errorResult(errorMessage(error))
  }
}

const mapToolError = (config: AgentsShellConfig, error: unknown): CallToolResult => {
  if (error instanceof AuthChallengeError) {
    return errorResult(error.message, buildBearerChallenge(config, error.oauthError, error.oauthDescription))
  }
  if (error instanceof AgentsShellRuntimeError && error.code) {
    return {
      ...errorResult(error.message),
      structuredContent: {
        code: error.code,
        message: error.message,
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      },
    }
  }
  return errorResult(errorMessage(error))
}

const callEffectTool = (tool: EffectTool, value: unknown) =>
  Effect.gen(function* () {
    const toolContext = yield* AgentsShellServices
    const result = yield* tool.handler(value, toolContext)
    return yield* Effect.tryPromise({
      try: () => validateOutput(tool, result),
      catch: (error) => error,
    })
  })

export const installEffectToolHandlers = (
  server: McpServer,
  tools: readonly EffectTool<any, any>[],
  context: EffectToolContext,
) => {
  const toolByName = new Map(tools.map((tool) => [tool.name, tool]))
  const toolLayer = makeAgentsShellServicesLayer(context)
  const catalog = tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: effectSchemaToJsonSchema(tool.inputSchema),
    annotations: tool.annotations,
    securitySchemes: tool.securitySchemes,
    _meta: tool._meta,
  }))
  const catalogReceipt = {
    version: context.config.version,
    sha256: createHash('sha256').update(JSON.stringify(catalog)).digest('hex'),
  }

  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: catalog,
    _meta: { 'agents-shell/catalog': catalogReceipt },
  }))

  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = toolByName.get(request.params.name)
    return toolAuditContext.run(
      { requestId: context.requestId, toolCallId: randomUUID(), tool: tool?.name ?? 'unknown' },
      async () => {
        const startedAt = performance.now()
        const { runner, auth } = context
        let authorized = false
        let input: unknown
        let requestError: CallToolResult | undefined
        try {
          if (tool) {
            requireScopes(auth, tool.scopes)
            authorized = true
            input = await decodeInput(tool, request.params.arguments ?? {})
          }
        } catch (error) {
          requestError = mapToolError(context.config, error)
        }
        const startedAuditErrors = runner.audit('tool_call_started', auth, {
          authorized,
          ...(authorized && !requestError ? { arguments: input } : {}),
        })
        let result: CallToolResult
        try {
          result =
            requestError ??
            (tool
              ? await Effect.runPromise(
                  callEffectTool(tool, input).pipe(
                    Effect.catchAll((error) => Effect.succeed(mapToolError(context.config, error))),
                    Effect.provide(toolLayer),
                  ),
                )
              : errorResult(`Tool ${request.params.name} not found`))
        } catch (error) {
          result = mapToolError(context.config, error)
        }
        const content = result.structuredContent
        const finishedAuditErrors = runner.audit('tool_call_finished', auth, {
          durationMs: performance.now() - startedAt,
          outcome: toolOutcome(tool?.name, result),
          ...(authorized && !tool?.name.startsWith('agent_') ? { result: content ?? result.content } : {}),
        })
        const auditSink = await runner.flushAudit()
        return {
          ...result,
          _meta: {
            ...result._meta,
            'agents-shell/trace': toolAuditContext.getStore(),
            'agents-shell/catalog': catalogReceipt,
            'agents-shell/audit': { rejectedCallFrames: startedAuditErrors + finishedAuditErrors, ...auditSink },
          },
        }
      },
    )
  })
}
