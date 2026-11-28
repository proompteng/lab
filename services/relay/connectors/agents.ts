import { readFile } from 'node:fs/promises'
import {
  targetSchema,
  relayRunToolDefinitions,
  relayRunTools,
  isRelayRunTool,
} from '../../agents/src/server/relay/contract'
import type { ConnectorRegistration } from '../onboarding'

const profile = JSON.parse(
  await readFile(new URL('../../../argocd/applications/agents/relay-targets.json', import.meta.url), 'utf8'),
)
const target = targetSchema.parse(profile.lab)

export default {
  connector: {
    type: 'mcp',
    id: 'agents',
    transport: {
      type: 'http',
      endpoint: 'https://agents.k8s.proompteng.ai/mcp/relay/lab',
      authentication: { type: 'spiffe_jwt', audience: 'https://agents.k8s.proompteng.ai/mcp/relay' },
    },
    operations: relayRunToolDefinitions().map((tool) => {
      if (!isRelayRunTool(tool.name)) throw new Error('Unregistered AgentRun tool')
      return {
        operation: {
          name: tool.name,
          description: tool.description,
          action: relayRunTools[tool.name].action,
          target: { name: target.name, kind: 'agents.target', id: target.id },
          input_schema: tool.inputSchema,
          read_only: tool.annotations.readOnlyHint,
        },
        tool: tool.name,
        relay_context: true,
      }
    }),
  },
  policy: {
    kind: 'agents.target',
    nativeType: 'agents_target',
    actions: [
      {
        id: 'agents.runs.read',
        permission: 'read',
        grantRelation: 'reader',
        workspaceGrantRelation: 'reader_workspace',
      },
      {
        id: 'agents.runs.logs',
        permission: 'read_logs',
        grantRelation: 'log_reader',
        workspaceGrantRelation: 'log_reader_workspace',
      },
      {
        id: 'agents.runs.start',
        permission: 'start',
        grantRelation: 'starter',
        workspaceGrantRelation: 'starter_workspace',
      },
      {
        id: 'agents.runs.cancel',
        permission: 'cancel',
        grantRelation: 'canceller',
        workspaceGrantRelation: 'canceller_workspace',
      },
    ],
  },
  targets: [{ workspaceId: target.workspaceId, id: target.id, name: target.name }],
} satisfies ConnectorRegistration
