import { z } from 'zod'

export const podMetadataSchema = z.object({
  name: z.string().optional(),
  namespace: z.string().optional(),
  creationTimestamp: z.preprocess(
    (val) => (val instanceof Date ? val : new Date(String(val))),
    z
      .date()
      .refine((date) => !Number.isNaN(date.getTime()), {
        message: 'Invalid date format for creationTimestamp',
      })
      .refine(
        (date) => {
          const now = new Date()
          const allowedSkew = 60 * 1000 // Allow 1 minute of clock skew
          return date <= new Date(now.getTime() + allowedSkew)
        },
        {
          message: 'creationTimestamp cannot be too far in the future',
        },
      )
      .optional(),
  ),
  uid: z.string().optional(),
})

export const containerPortSchema = z.object({
  containerPort: z.number().int().min(1).max(65535),
  protocol: z.string().optional(),
})

export const containerSchema = z.object({
  name: z.string().min(1),
  image: z.string().min(1),
  ports: z.array(containerPortSchema).optional(),
})

export const podSpecSchema = z.object({
  nodeName: z.string().optional(),
  containers: z.array(containerSchema).optional(),
  restartPolicy: z.string().optional(),
  serviceAccountName: z.string().optional(),
  dnsPolicy: z.string().optional(),
  priority: z.number().optional(),
})

export const podStatusSchema = z.object({
  phase: z.string().optional(),
  podIp: z.string().optional(),
  hostIp: z.string().optional(),
})

export const podSchema = z.object({
  metadata: podMetadataSchema.optional(),
  status: podStatusSchema.optional(),
  spec: podSpecSchema.optional(),
})

export const podListSchema = z.array(podSchema)

// Types inferred from schemas
export type PodMetadata = z.infer<typeof podMetadataSchema>
export type ContainerPort = z.infer<typeof containerPortSchema>
export type Container = z.infer<typeof containerSchema>
export type PodSpec = z.infer<typeof podSpecSchema>
export type PodStatus = z.infer<typeof podStatusSchema>
export type Pod = z.infer<typeof podSchema>
export type PodList = z.infer<typeof podListSchema>
