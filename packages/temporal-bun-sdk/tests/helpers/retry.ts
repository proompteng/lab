export async function withRetry<T>(
  fn: () => T | Promise<T>,
  attempts: number,
  waitMs: number,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt === attempts) {
        break
      }
      await Bun.sleep(waitMs)
    }
  }

  throw lastError
}

export async function waitForWorkerReady(
  worker: ReturnType<typeof Bun.spawn>,
  options: { readySubstring?: string; timeoutMs?: number } = {},
): Promise<void> {
  const { readySubstring = 'Worker ready', timeoutMs = 3000 } = options
  const stdout = worker.stdout
  if (!stdout) {
    throw new Error('Worker stdout not available')
  }

  const reader = stdout.getReader()
  const decoder = new TextDecoder()

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Worker readiness timeout after ${timeoutMs}ms`))
    }, timeoutMs)
  })

  try {
    await Promise.race([
      (async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done || !value) {
            throw new Error('Worker exited before signaling readiness')
          }
          const text = decoder.decode(value)
          if (text.includes(readySubstring)) {
            break
          }
        }
      })(),
      timeout,
    ])
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle)
    }
    reader.releaseLock()
  }
}
