import { type CreateAuditEventInput, createPrimitivesStore } from '~/server/primitives-store'

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
    // audit is best-effort
  } finally {
    if (store) {
      await store.close()
    }
  }
}
