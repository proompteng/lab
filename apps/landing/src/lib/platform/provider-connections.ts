import { z } from 'zod'

export const providerId = z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/)
export const providerReturnPath = z
  .string()
  .max(2048)
  .regex(/^\/(?!\/)/)
  .refine((path) => !/[\\#\p{Cc}]/u.test(path), 'Use a local return path')
export const providerMutationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('begin'),
    operationId: z.uuid(),
    profileId: providerId,
    returnPath: providerReturnPath,
  }),
  z.strictObject({
    kind: z.literal('disconnect'),
    operationId: z.uuid(),
    profileId: providerId,
    connectionId: z.uuid(),
  }),
])
export type ProviderMutation = z.infer<typeof providerMutationSchema>
export const providerResultSchema = z.enum(['connected', 'cancelled', 'account-mismatch', 'failed', 'access-removed'])
export type ProviderResult = z.infer<typeof providerResultSchema>
export const providerResultMessage: Record<ProviderResult, string> = {
  connected: 'Account connected.',
  cancelled: 'Connection cancelled. Your choices are saved.',
  'account-mismatch': 'Use the account you originally connected. The selected account was not connected.',
  failed: 'The account connection could not be confirmed. Try connecting again.',
  'access-removed': 'Your access changed during setup. Ask your workspace admin to review it.',
}
