import { z } from 'zod'

export const createAgentFormSchema = z.object({
  displayName: z.string().trim().min(1, 'Enter an agent name').max(64, 'Use 64 characters or fewer'),
})

export type CreateAgentFormValues = z.infer<typeof createAgentFormSchema>
