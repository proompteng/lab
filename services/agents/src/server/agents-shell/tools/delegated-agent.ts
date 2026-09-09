import { Effect } from 'effect'

import { READ_SCOPES, WRITE_SCOPES, destructiveAnnotations, openReadOnlyAnnotations } from '../constants'
import { buildAgentRunManifest } from '../agent-run'
import { agentsShellErrorFromUnknown } from '../errors'
import { asPositiveInteger } from '../limits'
import { toolSecurityMeta, type EffectTool } from '../mcp-adapter'
import { jsonTextResult, parseJsonOrNull } from '../results'
import {
  AgentNameInputSchema,
  AgentReadInputSchema,
  AgentStartInputSchema,
  AgentStartOutputSchema,
  AgentStatusOutputSchema,
  CommandResultSchema,
  type AgentNameInput,
  type AgentReadInput,
  type AgentStartInput,
} from '../schemas'

export const createDelegatedAgentTools = (): EffectTool[] => [
  {
    name: 'agent_start',
    title: 'Start delegated agent',
    description: 'Create a read-write Codex AgentRun for proompteng/lab.',
    inputSchema: AgentStartInputSchema,
    outputSchema: AgentStartOutputSchema,
    annotations: destructiveAnnotations,
    scopes: WRITE_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (args: AgentStartInput, { config, runner, auth }) =>
      Effect.tryPromise({
        try: async () => {
          const manifest = buildAgentRunManifest(config, args)
          const spec = manifest.spec as {
            parameters: { repository: string; base: string; head: string }
          }
          const result = await runner.runProcess({
            command: 'kubectl',
            args: ['apply', '-n', config.agentNamespace, '-f', '-'],
            stdin: JSON.stringify(manifest, null, 2),
            timeoutSeconds: args.timeoutSeconds,
            maxOutputBytes: args.maxOutputBytes,
            auth,
            auditEvent: 'agent_start',
          })
          return jsonTextResult({
            ok: result.ok,
            agentRunName: manifest.metadata.name,
            namespace: config.agentNamespace,
            repository: spec.parameters.repository,
            baseBranch: spec.parameters.base,
            headBranch: spec.parameters.head,
            apply: result,
          })
        },
        catch: agentsShellErrorFromUnknown,
      }),
  },
  {
    name: 'agent_status',
    title: 'Read delegated agent status',
    description: 'Read a delegated AgentRun object and matching Jobs.',
    inputSchema: AgentNameInputSchema,
    outputSchema: AgentStatusOutputSchema,
    annotations: openReadOnlyAnnotations,
    scopes: READ_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (args: AgentNameInput, { config, runner, auth }) =>
      Effect.tryPromise({
        try: async () => {
          const namespace = args.namespace ?? config.agentNamespace
          const getAgentRun = await runner.runProcess({
            command: 'kubectl',
            args: ['get', 'agentrun', args.agentRunName, '-n', namespace, '-o', 'json'],
            timeoutSeconds: args.timeoutSeconds,
            maxOutputBytes: args.maxOutputBytes,
            auth,
            auditEvent: 'agent_status_get_agentrun',
          })
          const getJobs = await runner.runProcess({
            command: 'kubectl',
            args: [
              'get',
              'jobs',
              '-n',
              namespace,
              '-l',
              `agents.proompteng.ai/agent-run=${args.agentRunName}`,
              '-o',
              'json',
            ],
            timeoutSeconds: args.timeoutSeconds,
            maxOutputBytes: args.maxOutputBytes,
            auth,
            auditEvent: 'agent_status_get_jobs',
          })
          return jsonTextResult({
            ok: getAgentRun.ok,
            agentRunName: args.agentRunName,
            namespace,
            agentRun: parseJsonOrNull(getAgentRun.stdout),
            jobs: parseJsonOrNull(getJobs.stdout),
            getAgentRun,
            getJobs,
          })
        },
        catch: agentsShellErrorFromUnknown,
      }),
  },
  {
    name: 'agent_read',
    title: 'Read delegated agent logs',
    description: 'Read retained logs from a delegated AgentRun job.',
    inputSchema: AgentReadInputSchema,
    outputSchema: CommandResultSchema,
    annotations: openReadOnlyAnnotations,
    scopes: READ_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (args: AgentReadInput, { config, runner, auth }) =>
      Effect.tryPromise({
        try: async () => {
          const namespace = args.namespace ?? config.agentNamespace
          const tailLines = asPositiveInteger(args.tailLines, 'tailLines', 200, 5000, 1)
          return jsonTextResult(
            await runner.runProcess({
              command: 'kubectl',
              args: [
                'logs',
                '-n',
                namespace,
                '-l',
                `agents.proompteng.ai/agent-run=${args.agentRunName}`,
                '--all-containers=true',
                '--tail',
                String(tailLines),
              ],
              timeoutSeconds: args.timeoutSeconds,
              maxOutputBytes: args.maxOutputBytes,
              auth,
              auditEvent: 'agent_read',
            }),
          )
        },
        catch: agentsShellErrorFromUnknown,
      }),
  },
  {
    name: 'agent_cancel',
    title: 'Cancel delegated agent',
    description: 'Delete a delegated AgentRun so owned runtime resources are cleaned up.',
    inputSchema: AgentNameInputSchema,
    outputSchema: CommandResultSchema,
    annotations: destructiveAnnotations,
    scopes: WRITE_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (args: AgentNameInput, { config, runner, auth }) =>
      Effect.tryPromise({
        try: async () =>
          jsonTextResult(
            await runner.runProcess({
              command: 'kubectl',
              args: ['delete', 'agentrun', args.agentRunName, '-n', args.namespace ?? config.agentNamespace],
              timeoutSeconds: args.timeoutSeconds,
              maxOutputBytes: args.maxOutputBytes,
              auth,
              auditEvent: 'agent_cancel',
            }),
          ),
        catch: agentsShellErrorFromUnknown,
      }),
  },
]
