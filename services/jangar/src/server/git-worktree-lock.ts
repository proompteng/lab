let worktreeQueue: Promise<void> = Promise.resolve()

export const withWorktreeLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  const previous = worktreeQueue
  let release: () => void = () => {}
  const next = new Promise<void>((resolve) => {
    release = resolve
  })
  worktreeQueue = previous.then(
    () => next,
    () => next,
  )
  await previous
  try {
    return await fn()
  } finally {
    release()
  }
}
