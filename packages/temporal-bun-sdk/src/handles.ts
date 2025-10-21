import { clientClose, clientConnect, NativeHandle, workerShutdown, workerStart } from './ffi'
import { TemporalBridgeError, TemporalBridgeErrorCode } from './errors'

interface HandleDescriptor {
  readonly type: string
  readonly closeWhere: string
}

abstract class ManagedHandle {
  #closed = false
  protected readonly descriptor: HandleDescriptor
  protected readonly handle: NativeHandle

  protected constructor(descriptor: HandleDescriptor, handle: NativeHandle) {
    this.descriptor = descriptor
    this.handle = handle
  }

  get id(): NativeHandle {
    return this.handle
  }

  get isClosed(): boolean {
    return this.#closed
  }

  close(): void {
    if (this.#closed) {
      throw alreadyClosedError(this.descriptor, this.handle)
    }

    this.#closed = true
    try {
      this.closeNative(this.handle)
    } catch (error) {
      if (error instanceof TemporalBridgeError && error.code === TemporalBridgeErrorCode.AlreadyClosed) {
        return
      }
      this.#closed = false
      throw error
    }
  }

  protected abstract closeNative(handle: NativeHandle): void
}

export class ClientHandle extends ManagedHandle {
  private constructor(handle: NativeHandle) {
    super({ type: 'client', closeWhere: 'te_client_close' }, handle)
  }

  static open(): ClientHandle {
    const handle = clientConnect()
    return new ClientHandle(handle)
  }

  startWorker(): WorkerHandle {
    if (this.isClosed) {
      throw alreadyClosedError({ type: 'client', closeWhere: 'te_worker_start' }, this.handle)
    }
    const workerId = workerStart(this.handle)
    return new WorkerHandle(workerId, this.handle)
  }

  protected closeNative(handle: NativeHandle): void {
    clientClose(handle)
  }
}

export class WorkerHandle extends ManagedHandle {
  readonly clientId: NativeHandle

  private constructor(handle: NativeHandle, clientId: NativeHandle) {
    super({ type: 'worker', closeWhere: 'te_worker_shutdown' }, handle)
    this.clientId = clientId
  }

  static start(client: ClientHandle): WorkerHandle {
    return client.startWorker()
  }

  protected closeNative(handle: NativeHandle): void {
    workerShutdown(handle)
  }
}

export async function withClient<T>(callback: (client: ClientHandle) => Promise<T> | T): Promise<T> {
  const client = ClientHandle.open()
  try {
    const result = await callback(client)
    finalizeClient(client)
    return result
  } catch (error) {
    try {
      finalizeClient(client)
    } catch (closeError) {
      if (!(closeError instanceof TemporalBridgeError) || closeError.code !== TemporalBridgeErrorCode.AlreadyClosed) {
        throw closeError
      }
    }
    throw error
  }
}

function finalizeClient(client: ClientHandle): void {
  if (client.isClosed) {
    return
  }
  client.close()
}

function alreadyClosedError(descriptor: HandleDescriptor, handle: NativeHandle): TemporalBridgeError {
  return new TemporalBridgeError({
    code: TemporalBridgeErrorCode.AlreadyClosed,
    message: `${descriptor.type} handle ${handle.toString()} is already closed`,
    where: descriptor.closeWhere,
    raw: '',
  })
}
