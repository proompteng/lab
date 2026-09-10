import { createServerFn } from '@tanstack/react-start'

import { buildSnapshot } from './gateway'
import { loadGatewayState } from './persistence'

export const gatewaySnapshotServerFn = createServerFn({ method: 'GET' }).handler(async () =>
  buildSnapshot(await loadGatewayState()),
)
