import { asRecord, asString } from '~/server/primitives-http'
import type { createKubernetesClient } from '~/server/primitives-kube'
import type { createPrimitivesStore } from '~/server/primitives-store'

const decodeSecretData = (secret: Record<string, unknown>) => {
  const data = asRecord(secret.data) ?? {}
  const decoded: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    const raw = asString(value)
    if (!raw) continue
    try {
      decoded[key] = Buffer.from(raw, 'base64').toString('utf8')
    } catch {
      decoded[key] = raw
    }
  }
  return decoded
}

export const hydrateMemoryRecord = async (
  memory: Record<string, unknown>,
  namespace: string,
  kube: ReturnType<typeof createKubernetesClient>,
  store: ReturnType<typeof createPrimitivesStore>,
) => {
  const status = asRecord(memory.status) ?? {}
  const connRef = asRecord(status.connectionSecretRef)
  const secretName = asString(connRef?.name)
  const secretNamespace = asString(connRef?.namespace) ?? namespace
  let connectionSecret: Record<string, unknown> | undefined
  if (secretName) {
    const secret = await kube.get('secret', secretName, secretNamespace)
    if (secret) {
      connectionSecret = decodeSecretData(secret)
    }
  }

  const spec = asRecord(memory.spec) ?? {}
  const providerName = asString(asRecord(spec.providerRef)?.name) ?? 'unknown'
  const statusPhase = asString(status.phase) ?? 'Pending'

  return store.upsertMemoryResource({
    memoryName: asString(asRecord(memory.metadata)?.name) ?? '',
    provider: providerName,
    status: statusPhase,
    connectionSecret: connectionSecret ?? null,
  })
}
