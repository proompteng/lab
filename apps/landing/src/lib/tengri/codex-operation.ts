import { z } from 'zod'
import { codexReasoningEffortSchema, type TengriCodexOptions } from './codex-models'

const pendingOperation = z.strictObject({
  id: z.uuid(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  turnId: z.string(),
  options: z.strictObject({ model: z.string().optional(), reasoningEffort: codexReasoningEffortSchema.optional() }),
})

export async function prepareCodexOperation(
  key: string,
  input: unknown,
  turnId: string,
  options: TengriCodexOptions = {},
  storage: Storage = localStorage,
) {
  const encoded = new TextEncoder().encode(JSON.stringify(input))
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const retained = storage.getItem(key)
  if (retained) {
    const previous = pendingOperation.parse(JSON.parse(retained))
    if (previous.fingerprint === fingerprint) return previous
  }
  const id = crypto.randomUUID()
  const operation = { id, fingerprint, turnId, options }
  storage.setItem(key, JSON.stringify(operation))
  return operation
}

export function completeCodexOperation(key: string, id: string, storage: Storage = localStorage) {
  const retained = storage.getItem(key)
  if (retained && pendingOperation.parse(JSON.parse(retained)).id === id) storage.removeItem(key)
}
