import { type CreateAuditEventInput, createPrimitivesStore } from './primitives-store'

export const emitAuditEventBestEffort = async (
  input: CreateAuditEventInput,
  deps: { storeFactory?: typeof createPrimitivesStore } = {},
) => {
  let store: ReturnType<typeof createPrimitivesStore> | null = null
  try {
    store = (deps.storeFactory ?? createPrimitivesStore)()
    await store.ready
    await store.createAuditEvent(input)
  } catch {
    // Audit delivery is explicitly best-effort and must not block reconciliation.
  } finally {
    if (store) {
      await store.close()
    }
  }
}
