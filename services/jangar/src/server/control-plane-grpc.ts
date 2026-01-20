import type { GrpcStatus } from '~/server/control-plane-status'

const DEFAULT_GRPC_PORT = 50051

export const resolveGrpcStatus = (): GrpcStatus => {
  const enabled = (process.env.JANGAR_GRPC_ENABLED ?? '').trim().toLowerCase()
  if (!['1', 'true', 'yes', 'on'].includes(enabled)) {
    return {
      enabled: false,
      address: '',
      status: 'disabled',
      message: 'gRPC disabled',
    }
  }

  const host = (process.env.JANGAR_GRPC_HOST ?? '').trim() || '127.0.0.1'
  const port = Number.parseInt(process.env.JANGAR_GRPC_PORT ?? '', 10) || DEFAULT_GRPC_PORT
  const address = process.env.JANGAR_GRPC_ADDRESS?.trim() || `${host}:${port}`

  return {
    enabled: true,
    address,
    status: 'healthy',
    message: '',
  }
}
