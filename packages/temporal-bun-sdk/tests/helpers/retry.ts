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
