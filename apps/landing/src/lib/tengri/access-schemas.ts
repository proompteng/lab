import { z } from 'zod'

export const workspaceUidSchema = z
  .uuid()
  .refine((value) => value === value.toLowerCase() && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value))
export const githubLoginSchema = z
  .string()
  .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/, 'Enter a GitHub username')
export const diagnosticActions = [
  'metadata',
  'files',
  'terminal',
  'codex',
  'browser',
  'preview',
  'kube-status',
  'kube-logs',
  'kube-events',
  'connector',
] as const
export const diagnosticActionSchema = z.enum(diagnosticActions)
export const accessResourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace'), id: workspaceUidSchema }).strict(),
  z.object({ kind: z.literal('namespace'), id: z.string().regex(/^galactic\/[0-9a-f-]{36}$/) }).strict(),
  z.object({ kind: z.literal('connector'), id: workspaceUidSchema }).strict(),
])
export const observationScopeSchema = z
  .object({
    fileRoots: z.array(z.string().min(2).max(4096)).max(16),
    threadIds: z.array(z.string().min(1).max(128)).max(32),
    terminalIds: z.array(z.string().min(1).max(128)).max(16),
    browserScreenshot: z.boolean(),
    maxBytes: z.number().int().min(1).max(1_048_576),
    maxItems: z.number().int().min(1).max(200),
  })
  .strict()
const common = {
  operationId: z.uuid(),
  expectedVersion: z.string().regex(/^[1-9][0-9]{0,18}$/),
  reason: z
    .string()
    .min(3)
    .max(500)
    .regex(/^[^\p{Cc}]+$/u, 'Use a single line reason without control characters'),
}
export const accessCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      ...common,
      action: z.literal('membership'),
      login: githubLoginSchema,
      role: z.enum(['member', 'administrator', 'auditor', 'operator']),
      enabled: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('collaborator'),
      workspaceUid: workspaceUidSchema,
      login: githubLoginSchema,
      role: z.enum(['developer', 'viewer']),
      enabled: z.boolean(),
    })
    .strict(),
  z
    .object({ ...common, action: z.literal('transfer'), workspaceUid: workspaceUidSchema, login: githubLoginSchema })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('quota'),
      login: githubLoginSchema,
      total: z.number().int().min(0).max(6),
      active: z.number().int().min(0).max(6),
      retainedGiB: z.number().int().min(0).max(192),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('target'),
      login: githubLoginSchema,
      resource: accessResourceSchema,
      permission: z.enum(['kube-status', 'kube-logs', 'kube-events', 'connector']),
      enabled: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('grant'),
      workspaceUid: workspaceUidSchema,
      grantId: workspaceUidSchema,
      agentId: workspaceUidSchema,
      resource: accessResourceSchema,
      permissions: z.array(diagnosticActionSchema).min(1).max(10),
      scope: observationScopeSchema,
      expiresAt: z.iso.datetime(),
      proofKeyThumbprint: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    })
    .strict(),
  z
    .object({ ...common, action: z.literal('revoke'), workspaceUid: workspaceUidSchema, grantId: workspaceUidSchema })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('emergency'),
      workspaceUid: workspaceUidSchema,
      login: githubLoginSchema,
      incidentId: z
        .string()
        .min(3)
        .max(128)
        .regex(/^[a-zA-Z0-9._:/-]+$/),
      approvalId: z.union([workspaceUidSchema, z.literal('')]),
      expiresAt: z.iso.datetime(),
    })
    .strict(),
])
export type AccessCommand = z.infer<typeof accessCommandSchema>
