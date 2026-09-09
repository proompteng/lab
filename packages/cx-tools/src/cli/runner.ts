import { spawn } from 'node:child_process'

export interface RunCommandOptions {
  input?: string
  env?: Record<string, string>
}

const toExitCode = (code: number | null, signal: NodeJS.Signals | null) => {
  if (typeof code === 'number') {
    return code
  }
  if (signal === 'SIGINT' || signal === 'SIGTERM') {
    return 130
  }
  return 1
}

export const runCommand = async (
  command: string,
  args: string[],
  { input, env }: RunCommandOptions = {},
): Promise<number> => {
  type EventedChildProcess = {
    on: (
      event: 'error' | 'close',
      listener: (...args: (number | string | NodeJS.Signals | Error | null)[]) => void,
    ) => void
    stdout?: NodeJS.ReadableStream | null
    stderr?: NodeJS.ReadableStream | null
    stdin?: NodeJS.WritableStream | null
  }

  return new Promise<number>((resolve) => {
    const eventedChild = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as unknown as EventedChildProcess

    if (input === undefined) {
      eventedChild.stdin?.end()
    } else {
      eventedChild.stdin?.write(input)
      eventedChild.stdin?.end()
    }

    eventedChild.stdout?.on('data', (chunk) => process.stdout.write(chunk))
    eventedChild.stderr?.on('data', (chunk) => process.stderr.write(chunk))

    eventedChild.on('error', (error) => {
      console.error(`Failed to execute ${command}: ${error instanceof Error ? error.message : String(error)}`)
      resolve(1)
    })

    eventedChild.on('close', (code, signal) => {
      const normalizedSignal = typeof signal === 'string' ? (signal as NodeJS.Signals) : null
      resolve(toExitCode(typeof code === 'number' ? code : null, normalizedSignal))
    })
  })
}
