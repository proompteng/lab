import { z } from 'zod'

export const RegistryConfigSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  baseUrl: z.string().url(),
  openapiUrl: z.string().url(),
  auth: z
    .object({
      type: z.enum(['bearer', 'basic', 'none']),
      tokenEnv: z.string().optional(),
      usernameEnv: z.string().optional(),
      passwordEnv: z.string().optional(),
    })
    .optional(),
  capabilities: z
    .object({
      supportsReadme: z.boolean().default(false),
      supportsMetrics: z.boolean().default(false),
      supportsSbom: z.boolean().default(false),
    })
    .default({}),
  tls: z
    .object({
      allowInsecure: z.boolean().default(false),
      allowHttp: z.boolean().default(false),
    })
    .default({}),
  authProvider: z.string().optional(),
})

export type RegistryConfig = z.infer<typeof RegistryConfigSchema>

export function defineRegistries(registries: RegistryConfig[]) {
  return registries
}
