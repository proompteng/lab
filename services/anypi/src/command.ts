import type { CommandResult } from './types'

export type RunCommandOptions = {
  cwd?: string
  env?: Record<string, string | undefined>
  allowFailure?: boolean
  input?: string
  onOutput?: (chunk: string) => void | Promise<void>
}

const buildEnv = (env?: Record<string, string | undefined>) =>
  Object.fromEntries(
    Object.entries(env ? { ...process.env, ...env } : process.env).filter(([, value]) => value !== undefined),
  ) as Record<string, string>

const readStream = async (
  stream: ReadableStream<Uint8Array> | null,
  onOutput?: (chunk: string) => void | Promise<void>,
) => {
  if (!stream) return ''
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const text = decoder.decode(value, { stream: true })
    output += text
    await onOutput?.(text)
  }
  const tail = decoder.decode()
  output += tail
  if (tail) await onOutput?.(tail)
  return output
}

export const runCommand = async (
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> => {
  const started = Date.now()
  const subprocess = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: buildEnv(options.env),
    stdin: options.input ? 'pipe' : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (options.input) {
    subprocess.stdin?.write(options.input)
    subprocess.stdin?.end()
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    readStream(subprocess.stdout, options.onOutput),
    readStream(subprocess.stderr, options.onOutput),
  ])
  const result = {
    command,
    args,
    cwd: options.cwd,
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - started,
  }
  if (exitCode !== 0 && !options.allowFailure) {
    const rendered = [command, ...args].join(' ')
    throw new Error(`command failed (${exitCode}): ${rendered}\n${stderr || stdout}`.trim())
  }
  return result
}

export const runShell = async (script: string, options: RunCommandOptions = {}) =>
  await runCommand('bash', ['-lc', script], options)
