import type { GatewaySnapshot } from '~/server/gateway'
import { gatewaySnapshotServerFn } from '~/server/server-fns'

export const loadInitialSnapshot = async (): Promise<GatewaySnapshot> => gatewaySnapshotServerFn()
