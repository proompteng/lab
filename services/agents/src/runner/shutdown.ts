const SHUTDOWN_GRACE_MS = 5_000
// Leave time for local status and stdout after remote flushes hit their deadline.
const REMOTE_FLUSH_GRACE_MS = 4_000

export const runnerSignalExitCode = (signal: unknown) => (signal === 'SIGTERM' ? 143 : 130)

export const withRunnerSignalHandlers = async (run: (signal: AbortSignal) => Promise<number>): Promise<number> => {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = (signal: 'SIGTERM' | 'SIGINT') => {
    if (controller.signal.aborted) return
    timer = setTimeout(() => {
      process.stderr.write(`agent-runner: ${signal} shutdown exceeded ${SHUTDOWN_GRACE_MS}ms\n`)
      // eslint-disable-next-line unicorn/no-process-exit
      process.exit(runnerSignalExitCode(signal))
    }, SHUTDOWN_GRACE_MS)
    controller.abort(signal)
  }
  const terminate = () => stop('SIGTERM')
  const interrupt = () => stop('SIGINT')
  process.on('SIGTERM', terminate)
  process.on('SIGINT', interrupt)
  try {
    const exitCode = await run(controller.signal)
    return controller.signal.aborted ? runnerSignalExitCode(controller.signal.reason) : exitCode
  } finally {
    clearTimeout(timer)
    process.off('SIGTERM', terminate)
    process.off('SIGINT', interrupt)
  }
}

export const createRemoteFlushDeadline = (shutdown: AbortSignal | undefined) => {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const onShutdown = () => {
    timer = setTimeout(
      () => controller.abort(new Error(`runner remote flush exceeded ${REMOTE_FLUSH_GRACE_MS}ms shutdown budget`)),
      REMOTE_FLUSH_GRACE_MS,
    )
  }
  if (shutdown?.aborted) onShutdown()
  else shutdown?.addEventListener('abort', onShutdown, { once: true })
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      shutdown?.removeEventListener('abort', onShutdown)
    },
  }
}

export const waitWithSignal = async <T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> => {
  if (!signal) return work
  let onAbort: () => void = () => {}
  const abort = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([work, abort])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
