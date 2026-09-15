export type IsolatedCommandResult = {
  exitCode: number | null
  stdout: string
  stderr: string
}

const WORKER_RESPONSE_GRACE_MS = 5_000

export const runCommandIsolated = (
  args: string[],
  cwd: string,
  timeoutMs: number,
  env?: Record<string, string | undefined>,
): Promise<IsolatedCommandResult> =>
  new Promise((resolve) => {
    const worker = new Worker(new URL('./command-worker.ts', import.meta.url).href)
    let settled = false

    const finish = (result: IsolatedCommandResult) => {
      if (settled) return
      settled = true
      clearTimeout(responseTimer)
      worker.terminate()
      resolve(result)
    }

    const responseTimer = setTimeout(() => {
      finish({
        exitCode: null,
        stdout: '',
        stderr: `command worker did not respond within ${timeoutMs + WORKER_RESPONSE_GRACE_MS}ms`,
      })
    }, timeoutMs + WORKER_RESPONSE_GRACE_MS)

    worker.onmessage = (event: MessageEvent<IsolatedCommandResult>) => finish(event.data)
    worker.onerror = (event) => {
      finish({
        exitCode: 1,
        stdout: '',
        stderr: event.message || 'command worker failed',
      })
    }
    worker.postMessage({ args, cwd, env, timeoutMs })
  })
