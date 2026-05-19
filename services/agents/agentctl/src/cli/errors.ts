import * as grpc from '@grpc/grpc-js'
import { EXIT_RUNTIME, EXIT_UNKNOWN, EXIT_VALIDATION } from '../legacy'

export const EXIT_KUBE = 3

export type AgentctlError =
  | { _tag: 'ValidationError'; message: string }
  | { _tag: 'KubeError'; message: string; cause?: unknown }
  | { _tag: 'GrpcError'; message: string; code?: number; cause?: unknown }
  | { _tag: 'IoError'; message: string; cause?: unknown }
  | { _tag: 'CodexError'; message: string; cause?: unknown }
  | { _tag: 'UnknownError'; message: string; cause?: unknown }

export const isAgentctlError = (value: unknown): value is AgentctlError =>
  !!value && typeof value === 'object' && '_tag' in value

export const asAgentctlError = (error: unknown, fallbackTag: AgentctlError['_tag'] = 'UnknownError'): AgentctlError => {
  if (isAgentctlError(error)) return error
  const message = error instanceof Error ? error.message : String(error)
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: number }).code
    return { _tag: 'GrpcError', message, code, cause: error }
  }
  return { _tag: fallbackTag, message, cause: error }
}

export const exitCodeFor = (error: AgentctlError): number => {
  if (error._tag === 'ValidationError') return EXIT_VALIDATION
  if (error._tag === 'GrpcError' && error.code !== undefined) {
    if (error.code === grpc.status.INVALID_ARGUMENT) return EXIT_VALIDATION
    if (error.code === grpc.status.FAILED_PRECONDITION || error.code === grpc.status.NOT_FOUND) return EXIT_RUNTIME
  }
  if (error._tag === 'KubeError') return EXIT_KUBE
  if (error._tag === 'GrpcError') return EXIT_RUNTIME
  return EXIT_UNKNOWN
}

export const formatError = (error: AgentctlError): string => error.message
