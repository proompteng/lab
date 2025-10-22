import { TemporalBridgeError } from './errors.ts'
import { closeClient, connectClient, drainErrorForTest, StatusCodes, shutdownWorker, startWorker } from './ffi.ts'

export type ClientHandleId = bigint
export type WorkerHandleId = bigint

export class ClientHandle {
  #handle: ClientHandleId
  #closed = false

  private constructor(handle: ClientHandleId) {
    this.#handle = handle
  }

  static create(config?: ArrayBufferView | ArrayBuffer | null): ClientHandle {
    return new ClientHandle(connectClient(config))
  }

  get id(): ClientHandleId {
    return this.#handle
  }

  get closed(): boolean {
    return this.#closed
  }

  close(): void {
    if (this.#closed) {
      throw new TemporalBridgeError({
        code: StatusCodes.alreadyClosed,
        msg: 'Client handle already closed',
        where: 'ClientHandle.close',
      })
    }
    closeClient(this.#handle)
    this.#closed = true
  }

  startWorker(options?: ArrayBufferView | ArrayBuffer | null): WorkerHandle {
    if (this.#closed) {
      throw new TemporalBridgeError({
        code: StatusCodes.invalidArgument,
        msg: 'Cannot start worker on closed client',
        where: 'ClientHandle.startWorker',
      })
    }
    return new WorkerHandle(startWorker(this.#handle, options))
  }
}

export class WorkerHandle {
  #handle: WorkerHandleId
  #closed = false

  constructor(handle: WorkerHandleId) {
    this.#handle = handle
  }

  get id(): WorkerHandleId {
    return this.#handle
  }

  get closed(): boolean {
    return this.#closed
  }

  shutdown(): void {
    if (this.#closed) {
      throw new TemporalBridgeError({
        code: StatusCodes.alreadyClosed,
        msg: 'Worker handle already shutdown',
        where: 'WorkerHandle.shutdown',
      })
    }
    shutdownWorker(this.#handle)
    this.#closed = true
  }
}

export function withClient<T>(
  config: ArrayBufferView | ArrayBuffer | null = null,
  run: (handle: ClientHandle) => T,
): T {
  const client = ClientHandle.create(config)
  try {
    return run(client)
  } finally {
    if (!client.closed) {
      try {
        client.close()
      } catch {
        drainErrorForTest()
      }
    }
  }
}
