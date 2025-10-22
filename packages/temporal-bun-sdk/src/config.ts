// Configuration for @proompteng/temporal-bun-sdk
export interface TemporalConfig {
  address: string
  namespace: string
  taskQueue: string
  apiKey?: string
  tls?: {
    caPath?: string
    certPath?: string
    keyPath?: string
    serverName?: string
  }
}

export function loadTemporalConfig(): TemporalConfig {
  const tls: { caPath?: string; certPath?: string; keyPath?: string; serverName?: string } = {}

  if (process.env.TEMPORAL_TLS_CA_PATH) {
    tls.caPath = process.env.TEMPORAL_TLS_CA_PATH
  }
  if (process.env.TEMPORAL_TLS_CERT_PATH) {
    tls.certPath = process.env.TEMPORAL_TLS_CERT_PATH
  }
  if (process.env.TEMPORAL_TLS_KEY_PATH) {
    tls.keyPath = process.env.TEMPORAL_TLS_KEY_PATH
  }
  if (process.env.TEMPORAL_TLS_SERVER_NAME) {
    tls.serverName = process.env.TEMPORAL_TLS_SERVER_NAME
  }

  return {
    address: process.env.TEMPORAL_ADDRESS ?? 'http://127.0.0.1:7233',
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'default',
    apiKey: process.env.TEMPORAL_API_KEY,
    tls: Object.keys(tls).length > 0 ? tls : undefined,
  }
}
