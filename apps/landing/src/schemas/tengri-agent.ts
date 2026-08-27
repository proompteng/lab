import { z } from 'zod'

export const agentDisplayNameSchema = z.string().trim().min(1, 'Enter an agent name').max(64, 'Use 64 characters or fewer')

export const createAgentFormSchema = z.strictObject({
  displayName: agentDisplayNameSchema,
})

export type CreateAgentFormValues = z.infer<typeof createAgentFormSchema>
