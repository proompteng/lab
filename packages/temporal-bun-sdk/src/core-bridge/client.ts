import { type NativeClient, native } from '../internal/core-bridge/native.ts'
import type { Runtime } from './runtime.ts'

export interface ClientTlsOptions {
  readonly serverRootCACertificate?: string
  readonly clientCert?: string
  readonly clientPrivateKey?: string
  readonly serverNameOverride?: string
}

export interface ClientOptions {
  readonly address: string
  readonly namespace: string
  readonly identity?: string
  readonly clientName?: string
  readonly clientVersion?: string
  readonly apiKey?: string
  readonly tls?: ClientTlsOptions
}

export class Client {
  #native: NativeClient | undefined
  readonly namespace: string

  static async connect(runtime: Runtime, options: ClientOptions): Promise<Client> {
    const client = new Client(runtime, options)
    await client.#init()
    return client
  }

  private constructor(
    private readonly runtime: Runtime,
    private readonly options: ClientOptions,
  ) {
    this.namespace = options.namespace
  }

  async #init(): Promise<void> {
    const nativeRuntime = this.runtime.nativeHandle
    const payload: Record<string, unknown> = {
      address: normalizeTemporalAddress(this.options.address, Boolean(this.options.tls)),
      namespace: this.options.namespace,
      identity: this.options.identity,
      client_name: this.options.clientName,
      client_version: this.options.clientVersion,
    }

    if (this.options.apiKey) {
      payload.api_key = this.options.apiKey
    }

    const tlsPayload = serializeTlsOptions(this.options.tls)
    if (tlsPayload) {
      payload.tls = tlsPayload
    }

    this.#native = await native.createClient(nativeRuntime, payload)
    clientFinalizer.register(this, this.#native, this)
  }

  get nativeHandle(): NativeClient {
    if (!this.#native) {
      throw new Error('Client has already been shut down')
    }
    return this.#native
  }

  async describeNamespace(namespace = this.namespace): Promise<Uint8Array> {
    const handle = this.nativeHandle
    return await native.describeNamespace(handle, namespace)
  }

  updateHeaders(headers: Record<string, string>): void {
    native.updateClientHeaders(this.nativeHandle, headers)
  }

  async shutdown(): Promise<void> {
    if (!this.#native) return
    native.clientShutdown(this.#native)
    clientFinalizer.unregister(this)
    this.#native = undefined
  }
}

export const createClient = async (runtime: Runtime, options: ClientOptions): Promise<Client> => {
  return await Client.connect(runtime, options)
}

const finalizeClient = (client: NativeClient): void => {
  try {
    native.clientShutdown(client)
  } catch {
    // Best-effort cleanup; ignore errors during GC finalization.
  }
}

const serializeTlsOptions = (tls?: ClientTlsOptions): Record<string, unknown> | undefined => {
  if (!tls) return undefined
  const payload: Record<string, unknown> = {}

  if (tls.serverRootCACertificate) {
    payload.serverRootCACertificate = tls.serverRootCACertificate
    payload.server_root_ca_cert = tls.serverRootCACertificate
  }

  if (tls.serverNameOverride) {
    payload.serverNameOverride = tls.serverNameOverride
    payload.server_name_override = tls.serverNameOverride
  }

  if (tls.clientCert && tls.clientPrivateKey) {
    payload.clientCertPair = {
      crt: tls.clientCert,
      key: tls.clientPrivateKey,
    }
    payload.client_cert = tls.clientCert
    payload.client_private_key = tls.clientPrivateKey
  }

  if (tls.clientCert && !tls.clientPrivateKey) {
    payload.clientCert = tls.clientCert
    payload.client_cert = tls.clientCert
  }

  if (!tls.clientCert && tls.clientPrivateKey) {
    payload.clientPrivateKey = tls.clientPrivateKey
    payload.client_private_key = tls.clientPrivateKey
  }

  return Object.keys(payload).length > 0 ? payload : undefined
}

const clientFinalizer = new FinalizationRegistry<NativeClient>(finalizeClient)

const ADDRESS_WITH_PROTOCOL = /^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//

export const normalizeTemporalAddress = (address: string, useTls = false): string => {
  if (ADDRESS_WITH_PROTOCOL.test(address)) {
    return address
  }
  const scheme = useTls ? 'https' : 'http'
  return `${scheme}://${address}`
}

export const __TEST__ = {
  finalizeClient,
  serializeTlsOptions,
}
