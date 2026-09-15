import type { ClientSessionOptions, SecureClientSessionOptions } from 'node:http2'
import type { Transport } from '@connectrpc/connect'
import type { GrpcTransportOptions } from '@connectrpc/connect-node'

import type { TemporalConfig, TLSConfig } from '../config'
import type { TemporalInterceptor } from './interceptors'

export type ClosableTransport = Transport & { close?: () => void | Promise<void> }

export const normalizeTemporalAddress = (address: string, useTls: boolean): string => {
  if (/^http(s)?:\/\//i.test(address)) {
    return address
  }
  return `${useTls ? 'https' : 'http'}://${address}`
}

export const buildTransportOptions = (
  baseUrl: string,
  config: TemporalConfig,
  interceptors: TemporalInterceptor[] = [],
): GrpcTransportOptions => {
  const nodeOptions: ClientSessionOptions | SecureClientSessionOptions = {}

  if (config.tls) {
    applyTlsConfig(nodeOptions, config.tls)
  }

  if (config.allowInsecureTls) {
    ;(nodeOptions as SecureClientSessionOptions).rejectUnauthorized = false
  }

  return {
    baseUrl,
    nodeOptions,
    defaultTimeoutMs: 60_000,
    interceptors,
  }
}

export const applyTlsConfig = (options: ClientSessionOptions | SecureClientSessionOptions, tls: TLSConfig): void => {
  const secure = options as SecureClientSessionOptions
  if (tls.serverRootCACertificate) {
    secure.ca = tls.serverRootCACertificate
  }
  if (tls.clientCertPair) {
    secure.cert = tls.clientCertPair.crt
    secure.key = tls.clientCertPair.key
  }
  if (tls.serverNameOverride) {
    secure.servername = tls.serverNameOverride
  }
}
