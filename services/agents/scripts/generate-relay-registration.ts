import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { relayRunTools, relayRunToolDefinitions, targetSchema, isRelayRunTool } from '../src/server/relay/contract'

const root = path.resolve(import.meta.dir, '../../..')
const targets = z
  .record(z.string(), targetSchema)
  .parse(JSON.parse(await readFile(path.join(root, 'argocd/applications/agents/relay-targets.json'), 'utf8')))
const configPath = path.join(root, 'argocd/applications/relay/config.json')
const original = await readFile(configPath, 'utf8')
const config = JSON.parse(original)
const definitions = relayRunToolDefinitions()
const target = targets.lab
if (!target) throw new Error('Lab Agents target is missing')
const connector = {
  type: 'mcp',
  id: 'agents',
  transport: {
    type: 'http',
    endpoint: 'https://agents.k8s.proompteng.ai/mcp/relay/lab',
    authentication: { type: 'spiffe_jwt', audience: 'https://agents.k8s.proompteng.ai/mcp/relay' },
  },
  operations: definitions.map((definition) => {
    if (!isRelayRunTool(definition.name)) throw new Error('unregistered tool')
    return {
      operation: {
        name: definition.name,
        description: definition.description,
        action: relayRunTools[definition.name].action,
        target: { name: target.name, kind: 'agents.target', id: target.id },
        input_schema: definition.inputSchema,
        read_only: definition.annotations.readOnlyHint,
      },
      tool: definition.name,
      relay_context: true,
    }
  }),
}
config.connectors = [...config.connectors.filter((entry: { id: string }) => entry.id !== 'agents'), connector]
const output = JSON.stringify(config, null, 2) + '\n'
if (process.argv.includes('--check')) {
  if (JSON.stringify(JSON.parse(original)) !== JSON.stringify(config))
    throw new Error('Relay registration drift; run generate-relay-registration.ts')
} else await writeFile(configPath, output)
