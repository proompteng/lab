import { z } from 'zod'

function body(maxBytes: number) {
  return z
    .string()
    .min(1)
    .max(Math.ceil(maxBytes / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
    .transform((value, context) => {
      const bytes = Buffer.from(value, 'base64')
      if (!bytes.length || bytes.length > maxBytes || bytes.toString('base64') !== value) {
        context.addIssue({ code: 'custom', message: 'Invalid Relay body encoding or byte budget' })
        return z.NEVER
      }
      return bytes
    })
}

export const relayEnvelope = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('execute'), body: body(65_536) }),
  z.strictObject({ kind: z.literal('lookup'), body: body(262_144) }),
])
