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
  return new Promise<number>((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: 'pipe',
    })

    child.stdin.end(input)
    child.stdout.on('data', (chunk) => process.stdout.write(chunk))
    child.stderr.on('data', (chunk) => process.stderr.write(chunk))

    child.on('error', (error) => {
      console.error(`Failed to execute ${command}: ${error.message}`)
      resolve(1)
    })

    child.on('close', (code, signal) => {
      resolve(toExitCode(code, signal))
    })
  })
}
