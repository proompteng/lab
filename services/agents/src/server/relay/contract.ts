import { z } from 'zod'

const run = z.strictObject({ runId: z.uuid() })
export const relayRunTools = {
  start_run: {
    description:
      'Start one task using the approved agent and repository. Returns a durable runId after admission. If the reply is lost, use get_run with the Relay operationId as runId; never submit the task again to recover it.',
    action: 'agents.runs.start',
    readOnly: false,
    schema: z.strictObject({
      task: z.string().trim().min(1).max(20_000),
      tokenBudget: z.number().int().positive().max(10_000_000).optional(),
    }),
  },
  list_runs: {
    description: 'List recent runs in this approved Agents target.',
    action: 'agents.runs.read',
    readOnly: true,
    schema: z.strictObject({ limit: z.number().int().min(1).max(50).default(20) }),
  },
  get_run: {
    description:
      'Read the current state and progress of a run. Also reconciles a lost start reply using its Relay operationId without submitting another run.',
    action: 'agents.runs.read',
    readOnly: true,
    schema: run,
  },
  read_logs: {
    description: 'Read bounded recent logs from a run in this target.',
    action: 'agents.runs.logs',
    readOnly: true,
    schema: run.extend({ lines: z.number().int().min(1).max(500).default(100) }),
  },
  get_result: {
    description:
      'Read the retained final response from a completed run. A pending or failed run is not reported as successful.',
    action: 'agents.runs.read',
    readOnly: true,
    schema: run,
  },
  cancel_run: {
    description:
      'Request cancellation of the exact run. Preserves its result and history; get_run confirms when cleanup finishes.',
    action: 'agents.runs.cancel',
    readOnly: false,
    schema: run,
  },
} as const
export type RelayRunTool = keyof typeof relayRunTools
export const isRelayRunTool = (name: string): name is RelayRunTool => Object.hasOwn(relayRunTools, name)
export const relayRunToolDefinitions = () =>
  Object.entries(relayRunTools).map(([name, tool]) => ({
    name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.schema, { target: 'draft-7' }),
    annotations: {
      readOnlyHint: tool.readOnly,
      destructiveHint: name === 'cancel_run',
      idempotentHint: tool.readOnly,
      openWorldHint: false,
    },
  }))

export const invocationSchema = z.strictObject({
  operationId: z.uuid(),
  clientService: z.string().min(1).max(128),
  actor: z.string().min(1).max(512),
  authorizationReceiptId: z.uuid(),
  action: z.string().min(1).max(128),
  resources: z
    .array(
      z.strictObject({ kind: z.literal('agents.target'), id: z.string().min(1).max(256), target: z.string().max(256) }),
    )
    .length(1),
})
export type Invocation = z.infer<typeof invocationSchema>

export const targetSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9/_-]{1,128}$/),
  name: z.string().min(1).max(128),
  workspaceId: z.uuid(),
  namespace: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  namespaceUid: z.uuid(),
  agent: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  base: z.string().min(1).max(128),
  vcsRef: z.string().min(1).max(128),
  secretBindingRef: z.string().min(1).max(128),
  secrets: z.array(z.string().min(1).max(128)).max(16),
  timeoutSeconds: z.number().int().min(60).max(86400),
})
export type Target = z.infer<typeof targetSchema>
