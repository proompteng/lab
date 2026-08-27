import { z } from 'zod'

const agentId = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
export const MAX_EDITABLE_FILE_BYTES = 4 * 1024 * 1024
export const MAX_CODEX_PROMPT_BYTES = 64 * 1024

const filePath = z
  .string()
  .startsWith('/')
  .max(4096)
  .refine((value) => !value.includes('\u0000') && !value.includes('\r') && !value.includes('\n'), 'Invalid file path')
const fileContent = z
  .string()
  .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_EDITABLE_FILE_BYTES, 'File content exceeds 4 MiB')
const codexPrompt = z
  .string()
  .trim()
  .min(1)
  .max(MAX_CODEX_PROMPT_BYTES)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_CODEX_PROMPT_BYTES, 'Prompt exceeds 64 KiB')
const codexId = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9._:-]+$/)

export const tengriActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('create-agent'), displayName: z.string().trim().min(1).max(64) }),
  z.strictObject({ action: z.literal('delete-agent'), agentId }),
  z.strictObject({ action: z.literal('sleep-agent'), agentId }),
  z.strictObject({ action: z.literal('resume-agent'), agentId }),
  z.strictObject({ action: z.literal('list-files'), agentId, path: filePath }),
  z.strictObject({ action: z.literal('read-file'), agentId, path: filePath }),
  z.strictObject({ action: z.literal('write-file'), agentId, path: filePath, content: fileContent }),
  z.strictObject({ action: z.literal('create-directory'), agentId, path: filePath }),
  z.strictObject({ action: z.literal('move-file'), agentId, sourcePath: filePath, destinationPath: filePath }),
  z.strictObject({ action: z.literal('delete-file'), agentId, path: filePath, recursive: z.boolean() }),
  z.strictObject({
    action: z.literal('search-files'),
    agentId,
    path: filePath,
    query: z.string().trim().min(1).max(256),
  }),
  z.strictObject({ action: z.literal('list-terminals'), agentId }),
  z.strictObject({
    action: z.literal('create-terminal'),
    agentId,
    cwd: filePath,
    columns: z.number().int().min(20).max(400),
    rows: z.number().int().min(6).max(200),
  }),
  z.strictObject({ action: z.literal('terminate-terminal'), agentId, terminalId: codexId }),
  z.strictObject({ action: z.literal('terminal-ticket'), agentId, terminalId: codexId }),
  z.strictObject({ action: z.literal('codex-account'), agentId }),
  z.strictObject({ action: z.literal('codex-login'), agentId }),
  z.strictObject({ action: z.literal('create-thread'), agentId }),
  z.strictObject({ action: z.literal('resume-thread'), agentId, threadId: codexId }),
  z.strictObject({
    action: z.literal('send-turn'),
    agentId,
    threadId: codexId,
    text: codexPrompt,
  }),
  z.strictObject({
    action: z.literal('steer-turn'),
    agentId,
    threadId: codexId,
    turnId: codexId,
    text: codexPrompt,
  }),
  z.strictObject({ action: z.literal('interrupt-turn'), agentId, threadId: codexId, turnId: codexId }),
  z.strictObject({
    action: z.literal('resolve-approval'),
    agentId,
    approvalId: codexId,
    decision: z.enum(['approve-once', 'approve-session', 'deny']),
  }),
  z.strictObject({
    action: z.literal('preview-session'),
    agentId,
    port: z.number().int().min(1024).max(65535),
    path: z
      .string()
      .startsWith('/')
      .max(4096)
      .refine(
        (value) => !value.includes('\u0000') && !value.includes('\r') && !value.includes('\n') && !value.includes('#'),
        'Invalid preview path',
      ),
  }),
])
