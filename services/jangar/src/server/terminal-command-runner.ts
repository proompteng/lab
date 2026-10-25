import { spawn } from 'node:child_process'

export type CommandResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export type CommandOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  label?: string
}

const readProcessText = async (stream: ReadableStream<Uint8Array> | null, signal?: AbortSignal) => {
  if (!stream) return ''
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let result = ''
  const onAbort = () => {
    void reader.cancel()
  }
  if (signal) {
    if (signal.aborted) {
      onAbort()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value || value.length === 0) continue
      result += decoder.decode(value, { stream: true })
    }
  } catch {
    // ignore
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort)
    result += decoder.decode()
  }
  return result
}

export const runCommand = async (args: string[], options: CommandOptions = {}): Promise<CommandResult> => {
  const bunRuntime = (globalThis as { Bun?: typeof Bun }).Bun
  if (bunRuntime) {
    const process = bunRuntime.spawn(args, {
      cwd: options.cwd,
      env: options.env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    let timedOut = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const abortController = new AbortController()
    const stdoutPromise = readProcessText(process.stdout, abortController.signal)
    const stderrPromise = readProcessText(process.stderr, abortController.signal)
    const exitPromise = process.exited.then((exitCode) => {
      abortController.abort()
      return exitCode ?? 1
    })

    let exitCode: number | null
    if (options.timeoutMs && Number.isFinite(options.timeoutMs)) {
      exitCode = await Promise.race([
        exitPromise,
        new Promise<number | null>((resolve) => {
          timeout = setTimeout(() => {
            timedOut = true
            try {
              process.kill('SIGKILL')
            } catch {
              // ignore
            }
            abortController.abort()
            resolve(null)
          }, options.timeoutMs)
        }),
      ])
    } else {
      exitCode = await exitPromise
    }

    if (timeout) clearTimeout(timeout)
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
    if (timedOut) {
      const label = options.label ?? args[0]
      const message = `${label} timed out after ${options.timeoutMs}ms`
      return { exitCode: 124, stdout, stderr: stderr ? `${stderr}\n${message}` : message }
    }
    return { exitCode: exitCode ?? 1, stdout, stderr }
  }

  return new Promise((resolvePromise) => {
    const child = spawn(args[0], args.slice(1), { cwd: options.cwd, env: options.env })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    if (options.timeoutMs && Number.isFinite(options.timeoutMs)) {
      timeout = setTimeout(() => {
        timedOut = true
        try {
          child.kill('SIGKILL')
        } catch {
          // ignore
        }
      }, options.timeoutMs)
    }
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      if (timeout) clearTimeout(timeout)
      resolvePromise({ exitCode: 1, stdout: '', stderr: error.message })
    })
    child.on('close', (exitCode) => {
      if (timeout) clearTimeout(timeout)
      if (timedOut) {
        const label = options.label ?? args[0]
        const message = `${label} timed out after ${options.timeoutMs}ms`
        resolvePromise({ exitCode: 124, stdout, stderr: stderr ? `${stderr}\n${message}` : message })
        return
      }
      resolvePromise({ exitCode: exitCode ?? 1, stdout, stderr })
    })
  })
}

const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0' })

export const runTerminalGit = async (args: string[], cwd?: string, options?: CommandOptions) =>
  runCommand(['git', ...args], { cwd, env: gitEnv(), ...options })
