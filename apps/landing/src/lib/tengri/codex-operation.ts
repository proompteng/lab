import { z } from 'zod'
import { codexReasoningEffortSchema, type TengriCodexOptions } from './codex-models'

const pendingOperation = z.strictObject({
  id: z.uuid(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  turnId: z.string(),
  options: z.strictObject({ model: z.string().optional(), reasoningEffort: codexReasoningEffortSchema.optional() }),
})

const operationTiming = z.strictObject({
  id: z.uuid(),
  submittedAtMs: z.number().int().positive().max(8_640_000_000_000_000),
})

function retainedSubmissionTime(key: string, id: string, storage: Storage) {
  try {
    const value = storage.getItem(`${key}:timing`)
    const timing = value ? operationTiming.safeParse(JSON.parse(value)) : null
    return timing?.success && timing.data.id === id ? timing.data.submittedAtMs : undefined
  } catch {
    return undefined
  }
}

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
    if (previous.fingerprint === fingerprint)
      return { ...previous, submittedAtMs: retainedSubmissionTime(key, previous.id, storage) }
  }
  const id = crypto.randomUUID()
  const operation = { id, fingerprint, turnId, options }
  storage.setItem(key, JSON.stringify(operation))
  const submittedAtMs = Date.now()
  try {
    // Keep display metadata outside the strict operation record so older open tabs
    // can still reconcile its identity during a rolling frontend update.
    storage.setItem(`${key}:timing`, JSON.stringify({ id, submittedAtMs }))
  } catch {
    // Timing persistence must never prevent dispatch or change its operation identity.
  }
  return { ...operation, submittedAtMs }
}

export function completeCodexOperation(key: string, id: string, storage: Storage = localStorage) {
  const retained = storage.getItem(key)
  if (retained && pendingOperation.parse(JSON.parse(retained)).id === id) {
    storage.removeItem(key)
    try {
      storage.removeItem(`${key}:timing`)
    } catch {
      // Non-authoritative display metadata can be replaced by the next operation.
    }
  }
}
