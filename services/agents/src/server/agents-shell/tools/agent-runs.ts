import { Effect, Schema } from 'effect'

import { getAgentRunMcpToolDefinitions, invokeAgentRunMcpTool } from '../../mcp'
import { READ_SCOPES, WRITE_SCOPES, openReadOnlyAnnotations, writeAnnotations } from '../constants'
import { agentsShellErrorFromUnknown } from '../errors'
import { toolSecurityMeta, type EffectTool } from '../mcp-adapter'

const toolNames = new Set(['create_agent_run', 'get_agent_run', 'get_agent_run_logs', 'cancel_agent_run'])

export const createAgentRunTools = (): EffectTool[] =>
  getAgentRunMcpToolDefinitions()
    .filter((tool) => toolNames.has(tool.name))
    .map((tool) => {
      const readOnly = /^(get|list)_/.test(tool.name)
      return {
        name: tool.name,
        title: tool.name.replaceAll('_', ' '),
        description: tool.description,
        inputSchema: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
        inputJsonSchema: tool.inputSchema,
        auditResult: false,
        annotations: readOnly
          ? openReadOnlyAnnotations
          : {
              ...writeAnnotations,
              destructiveHint: tool.name === 'cancel_agent_run',
              idempotentHint: true,
              openWorldHint: true,
            },
        scopes: readOnly ? READ_SCOPES : WRITE_SCOPES,
        ...toolSecurityMeta([READ_SCOPES[0]]),
        handler: (args: Record<string, unknown>, { config }) =>
          Effect.tryPromise({
            try: () => invokeAgentRunMcpTool(tool.name, args, config.resource),
            catch: agentsShellErrorFromUnknown,
          }),
      }
    })
