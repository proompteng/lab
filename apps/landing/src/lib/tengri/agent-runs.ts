import { z } from 'zod'

export const agentRunViewSchema = z.object({
  kind: z.literal('agent-run'),
  targetId: z.string().min(1).max(128),
  run: z.object({
    runId: z.uuid(),
    status: z.string().min(1).max(64),
    message: z.string().max(2000).optional(),
    progress: z
      .object({
        activeTools: z
          .array(z.object({ title: z.string().max(256) }))
          .max(8)
          .optional(),
      })
      .nullish(),
    result: z
      .object({ responseText: z.string().max(64_000).optional(), responseTruncated: z.boolean().optional() })
      .nullish(),
  }),
})
export type AgentRunView = z.infer<typeof agentRunViewSchema>
export const agentRunCommandSchema = z.strictObject({
  agentId: z.string().min(1).max(128),
  targetId: z.string().min(1).max(128),
  runId: z.uuid(),
  operationId: z.uuid(),
  operation: z.enum(['get_result', 'cancel_run']),
})
export type AgentRunCommand = z.infer<typeof agentRunCommandSchema>
export const agentRunTerminal = (status: string) =>
  ['Succeeded', 'Failed', 'Cancelled', 'Rejected', 'needs_iteration', 'needs_human'].includes(status)

// Relay and MCP each wrap a tool result. Read only their bounded result/content envelopes.
export function parseAgentRunView(value: unknown, depth = 0): AgentRunView | undefined {
  if (depth > 6) return
  if (typeof value === 'string') {
    if (value.length > 262_144) return
    try {
      return parseAgentRunView(JSON.parse(value), depth + 1)
    } catch {
      return
    }
  }
  const parsed = agentRunViewSchema.safeParse(value)
  if (parsed.success) return parsed.data
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  for (const key of ['structuredContent', 'result', 'content', 'contentItems', 'text']) {
    if (!(key in value)) continue
    const child: unknown = Reflect.get(value, key)
    const candidates = Array.isArray(child) ? child.slice(0, 10) : [child]
    for (const candidate of candidates) {
      const view = parseAgentRunView(candidate, depth + 1)
      if (view) return view
    }
  }
}
