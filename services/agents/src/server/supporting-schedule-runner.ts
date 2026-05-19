import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { createKubernetesClient } from './kube-types'

const DELIVERY_PLACEHOLDERS = ['__AGENTS_DELIVERY_ID__', '__JANGAR_DELIVERY_ID__']

const materializeManifest = (raw: string) => {
  const deliveryId = randomUUID()
  let rendered = raw
  for (const placeholder of DELIVERY_PLACEHOLDERS) {
    rendered = rendered.replaceAll(placeholder, deliveryId)
  }
  return JSON.parse(rendered) as Record<string, unknown>
}

export const runSupportingScheduleRunner = async (path = '/config/run.json') => {
  const raw = await readFile(path, 'utf8')
  const manifest = materializeManifest(raw)
  const applied = await createKubernetesClient().apply(manifest)
  const metadata = (applied.metadata && typeof applied.metadata === 'object' ? applied.metadata : {}) as Record<
    string,
    unknown
  >
  console.info('[agents] schedule runner applied manifest', {
    kind: applied.kind,
    namespace: metadata.namespace,
    name: metadata.name,
    generateName: metadata.generateName,
  })
  return applied
}

if (import.meta.main) {
  runSupportingScheduleRunner().catch((error) => {
    console.error('[agents] schedule runner failed', error)
    process.exitCode = 1
  })
}

export const __test__ = {
  materializeManifest,
}
