import { z } from 'zod'
import { policyReasonSchema } from './policies'

export const accessRequestMutationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('create'),
    operationId: z.uuid(),
    workspaceId: z.uuid(),
    resource: z.strictObject({ kind: z.string().min(1).max(128), id: z.string().min(1).max(256) }),
    actions: z.array(z.string().min(1).max(128)).min(1).max(16),
    reason: policyReasonSchema,
  }),
  z.strictObject({
    kind: z.literal('review'),
    operationId: z.uuid(),
    workspaceId: z.uuid(),
    requestId: z.uuid(),
    decision: z.enum(['approve', 'decline']),
    reason: policyReasonSchema,
  }),
  z.strictObject({ kind: z.literal('cancel'), operationId: z.uuid(), requestId: z.uuid() }),
])
export type AccessRequestMutation = z.infer<typeof accessRequestMutationSchema>

const actionNames: Record<string, string> = {
  'kubernetes.status.read': 'Pod status',
  'kubernetes.logs.read': 'Pod logs',
  'kubernetes.events.read': 'Namespace events',
}
export const accessActionName = (action: string) => actionNames[action] || action.replaceAll('.', ' ')
