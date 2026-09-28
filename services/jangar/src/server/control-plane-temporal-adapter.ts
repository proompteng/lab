import { loadTemporalConfig } from '@proompteng/temporal-bun-sdk'

import { buildLocalControlPlaneAuthority } from '~/server/control-plane-authority-status'
import type { RuntimeAdapterStatus } from '~/server/control-plane-status-types'

const DEFAULT_TEMPORAL_HOST = 'temporal-frontend.temporal.svc.cluster.local'
const DEFAULT_TEMPORAL_PORT = 7233
const DEFAULT_TEMPORAL_ADDRESS = `${DEFAULT_TEMPORAL_HOST}:${DEFAULT_TEMPORAL_PORT}`

const normalizeMessage = (value: unknown) => (value instanceof Error ? value.message : String(value))

export const resolveTemporalAdapter = async (): Promise<RuntimeAdapterStatus> => {
  try {
    const config = await loadTemporalConfig({
      defaults: { host: DEFAULT_TEMPORAL_HOST, port: DEFAULT_TEMPORAL_PORT, address: DEFAULT_TEMPORAL_ADDRESS },
    })
    return {
      name: 'temporal',
      available: true,
      status: 'configured',
      message: 'temporal configuration resolved',
      endpoint: config.address ?? DEFAULT_TEMPORAL_ADDRESS,
      authority: buildLocalControlPlaneAuthority('agents'),
    }
  } catch (error) {
    return {
      name: 'temporal',
      available: false,
      status: 'degraded',
      message: normalizeMessage(error),
      endpoint: DEFAULT_TEMPORAL_ADDRESS,
      authority: buildLocalControlPlaneAuthority('agents'),
    }
  }
}
