import { z } from 'zod'

const turnId = z.string().min(1).max(160)
const reason = z.string().min(1).max(2048)

export const codexRunStateSchema = z.discriminatedUnion('phase', [
  z.strictObject({ phase: z.literal('accepted') }),
  z.strictObject({ phase: z.literal('waiting_for_guest'), reason }),
  z.strictObject({ phase: z.literal('running'), turnId }),
  z.strictObject({
    phase: z.literal('waiting_for_approval'),
    turnId,
    approvals: z.array(z.strictObject({ approvalId: z.string().min(1).max(160), raw: z.unknown() })).max(32),
  }),
  z.strictObject({ phase: z.literal('cancelling'), turnId: turnId.nullable(), reason }),
  z.strictObject({ phase: z.literal('recovering'), turnId, reason }),
  z.strictObject({ phase: z.literal('succeeded'), turnId }),
  z.strictObject({ phase: z.literal('failed'), turnId, reason }),
  z.strictObject({ phase: z.literal('cancelled'), turnId: z.string().max(160) }),
  z.strictObject({ phase: z.literal('needs_reconciliation'), reason }),
  z.strictObject({ phase: z.literal('rejected'), reason }),
])

export const codexRunSchema = z.strictObject({
  runId: z.uuid(),
  agentId: z.string().min(1),
  threadId: z.string().min(1),
  state: codexRunStateSchema,
})

export type TengriCodexRun = z.infer<typeof codexRunSchema>

export function codexRunIsTerminal(run: TengriCodexRun) {
  return ['succeeded', 'failed', 'cancelled', 'rejected'].includes(run.state.phase)
}
