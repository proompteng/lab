import { describe, expect, test } from 'bun:test'
import { agentRunCommandSchema, parseAgentRunView } from './agent-runs'
const view = {
  kind: 'agent-run' as const,
  targetId: 'agents/lab',
  run: { runId: crypto.randomUUID(), status: 'Running' },
}
describe('AgentRun client boundary', () => {
  test('reads the real nested Relay and MCP result envelopes', () => {
    const mcp = { content: [{ type: 'text', text: JSON.stringify(view) }], structuredContent: view }
    const bridge = { result: { content: [{ type: 'text', text: JSON.stringify(mcp) }] } }
    expect(parseAgentRunView(bridge)).toEqual(view)
    expect(parseAgentRunView({ result: { structuredContent: view } })).toEqual(view)
    expect(parseAgentRunView({ contentItems: [{ type: 'inputText', text: JSON.stringify(mcp) }] })).toEqual(view)
  })
  test('does not interpret arbitrary tool text, invalid IDs or oversized content as a run', () => {
    expect(parseAgentRunView('ordinary output')).toBeUndefined()
    expect(parseAgentRunView({ ...view, run: { ...view.run, runId: 'raw-kubernetes-name' } })).toBeUndefined()
    expect(parseAgentRunView(' '.repeat(262145))).toBeUndefined()
    expect(parseAgentRunView({ kind: 'different-tool', run: view.run })).toBeUndefined()
  })
  test('the run card cannot start work or submit raw cluster configuration', () => {
    const command = {
      agentId: 'workspace',
      targetId: 'agents/lab',
      runId: view.run.runId,
      operationId: crypto.randomUUID(),
      operation: 'cancel_run' as const,
    }
    expect(agentRunCommandSchema.parse(command)).toEqual(command)
    expect(agentRunCommandSchema.safeParse({ ...command, operation: 'start_run' }).success).toBe(false)
    expect(agentRunCommandSchema.safeParse({ ...command, namespace: 'another' }).success).toBe(false)
  })
})
