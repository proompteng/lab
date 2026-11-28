import { z } from 'zod'

const valueSchema = z.union([z.string().max(8192), z.boolean(), z.number().finite()])
export const codexInputResponseSchema = z
  .union([
    z.strictObject({
      answers: z
        .record(z.string().min(1).max(160), z.strictObject({ answers: z.array(z.string().min(1).max(8192)).length(1) }))
        .refine((answers) => Object.keys(answers).length <= 10),
    }),
    z.strictObject({
      action: z.enum(['accept', 'decline', 'cancel']),
      content: z
        .record(z.string().min(1).max(160), valueSchema)
        .refine((content) => Object.keys(content).length <= 20)
        .optional(),
    }),
  ])
  .refine((response) => new TextEncoder().encode(JSON.stringify(response)).length <= 32768, 'The response is too large')
export type TengriCodexInputResponse = z.infer<typeof codexInputResponseSchema>
