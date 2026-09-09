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
import { CONNECTOR_LINK_SCOPES } from './constants'
import type { AgentsShellConfig } from './config'
import { errorMessage } from './errors'
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
  return errorResult(errorMessage(error))
}

const callEffectTool = (tool: EffectTool, value: unknown) =>
  Effect.gen(function* () {
    const toolContext = yield* AgentsShellServices
    yield* Effect.try({
      try: () => requireScopes(toolContext.auth, tool.scopes),
      catch: (error) => error,
    })
    const input = yield* Effect.tryPromise({
      try: () => decodeInput(tool, value),
      catch: (error) => error,
    })
    const result = yield* tool.handler(input, toolContext)
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

  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: effectSchemaToJsonSchema(tool.inputSchema),
      annotations: tool.annotations,
      securitySchemes: tool.securitySchemes,
      _meta: tool._meta,
    })),
  }))

  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = toolByName.get(request.params.name)
    if (!tool) return errorResult(`Tool ${request.params.name} not found`)

    try {
      return await Effect.runPromise(
        callEffectTool(tool, request.params.arguments ?? {}).pipe(
          Effect.catchAll((error) => Effect.succeed(mapToolError(context.config, error))),
          Effect.provide(toolLayer),
        ),
      )
    } catch (error) {
      return mapToolError(context.config, error)
    }
  })
}
