import { type ChildProcess, spawn } from 'node:child_process'

export type CommandOptions = {
  cwd?: string
  env?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
}
export type CommandResult = { exitCode: number; stdout: string; stderr: string }
export type CommandRunner = (command: string, args: string[], options?: CommandOptions) => Promise<CommandResult>

export const detachRunnerProcess = process.platform !== 'win32'
export const RUNNER_PROCESS_TERM_GRACE_MS = 1_000

export const waitForRunnerProcess = (
  child: ChildProcess,
  { signal, timeoutMs }: CommandOptions = {},
): Promise<{ exitCode: number; signal: NodeJS.Signals | null }> =>
  new Promise((resolve, reject) => {
    let deadline: ReturnType<typeof setTimeout> | undefined
    let escalation: ReturnType<typeof setTimeout> | undefined
    let reapDeadline: ReturnType<typeof setTimeout> | undefined
    let cancellation: { reason: unknown } | undefined
    let closed = false

    const signalProcess = (value: NodeJS.Signals | 0) => {
      if (detachRunnerProcess && child.pid) {
        try {
          process.kill(-child.pid, value)
          return true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return child.kill(value)
          return false
        }
      }
      return child.kill(value)
    }
    const cleanup = () => {
      clearTimeout(deadline)
      clearTimeout(escalation)
      clearTimeout(reapDeadline)
      signal?.removeEventListener('abort', onAbort)
    }
    const cancel = (reason: unknown) => {
      if (cancellation) return
      cancellation = { reason }
      signalProcess('SIGTERM')
      escalation = setTimeout(() => {
        escalation = undefined
        signalProcess('SIGKILL')
        if (closed) {
          cleanup()
          reject(reason)
        } else {
          reapDeadline = setTimeout(() => {
            // A descendant that opened its own session can still hold the pipes open.
            child.stdout?.destroy()
            child.stderr?.destroy()
            cleanup()
            reject(reason)
          }, RUNNER_PROCESS_TERM_GRACE_MS)
        }
      }, RUNNER_PROCESS_TERM_GRACE_MS)
    }
    const onAbort = () => cancel(signal?.reason)

    child.once('error', (error) => {
      cleanup()
      reject(error)
    })
    child.once('close', (code, childSignal) => {
      closed = true
      // Even if the leader and its pipes closed, a descendant can ignore SIGTERM.
      if (cancellation && escalation && signalProcess(0)) return
      cleanup()
      if (cancellation) reject(cancellation.reason)
      else resolve({ exitCode: code ?? 1, signal: childSignal })
    })

    if (timeoutMs !== undefined) {
      deadline = setTimeout(
        () => cancel(new DOMException(`command timed out after ${timeoutMs}ms`, 'TimeoutError')),
        timeoutMs,
      )
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })

export const runProcessCommand: CommandRunner = async (command, args, options = {}) => {
  options.signal?.throwIfAborted()
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    detached: detachRunnerProcess,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  const { exitCode } = await waitForRunnerProcess(child, options)
  return { exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }
}
