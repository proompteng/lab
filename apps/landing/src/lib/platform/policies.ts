import { z } from 'zod'

export const policyReasonSchema = z
  .string()
  .trim()
  .min(3, 'Explain the access change')
  .max(512)
  .regex(/^[^\p{Cc}]+$/u, 'Use a single line reason')
  .refine((value) => new TextEncoder().encode(value).length <= 512, 'Use a shorter reason')

export const policyWriteSchema = z.strictObject({
  operationId: z.uuid(),
  workspaceId: z.uuid(),
  expectedPolicyVersion: z.string().regex(/^[0-9]{1,19}$/),
  relationships: z
    .array(
      z.strictObject({
        resource: z.strictObject({ kind: z.string().min(1).max(128), id: z.string().min(1).max(256) }),
        relation: z.string().min(1).max(128),
        subjectKind: z.enum(['human', 'workload', 'workspace']),
        subjectId: z.string().min(1).max(512),
        enabled: z.boolean(),
      }),
    )
    .min(1)
    .max(128),
  reason: policyReasonSchema,
})
export type PolicyWrite = z.infer<typeof policyWriteSchema>
