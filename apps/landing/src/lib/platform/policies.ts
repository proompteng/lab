import { z } from 'zod'

export const policyWriteSchema = z.strictObject({
  operationId: z.uuid(),
  expectedPolicyVersion: z.string().regex(/^[0-9]{1,19}$/),
  relationships: z
    .array(
      z.strictObject({
        resource: z.strictObject({ kind: z.string().min(1).max(128), id: z.string().min(1).max(256) }),
        relation: z.string().min(1).max(128),
        subjectKind: z.enum(['human', 'workload']),
        subjectId: z.string().min(1).max(512),
        enabled: z.boolean(),
      }),
    )
    .min(1)
    .max(128),
  reason: z.string().min(3).max(512),
})
export type PolicyWrite = z.infer<typeof policyWriteSchema>
