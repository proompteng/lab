import { spawn as nodeSpawn } from 'node:child_process'

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

const readNodeStream = async (
  stream: NodeJS.ReadableStream | null,
  onOutput?: (chunk: string) => void | Promise<void>,
) => {
  if (!stream) return ''
  let output = ''
  for await (const chunk of stream) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    output += text
    await onOutput?.(text)
  }
  return output
}

const buildResult = (
  command: string,
  args: string[],
  options: RunCommandOptions,
  started: number,
  exitCode: number,
  stdout: string,
  stderr: string,
) => ({
  command,
  args,
  cwd: options.cwd,
  exitCode,
  stdout,
  stderr,
  durationMs: Date.now() - started,
})

const throwIfFailed = (result: CommandResult, allowFailure: boolean | undefined) => {
  if (result.exitCode === 0 || allowFailure) return
  const rendered = [result.command, ...result.args].join(' ')
  throw new Error(`command failed (${result.exitCode}): ${rendered}\n${result.stderr || result.stdout}`.trim())
}

const runCommandWithNode = async (
  command: string,
  args: string[],
  options: RunCommandOptions,
  started: number,
): Promise<CommandResult> => {
  const subprocess = nodeSpawn(command, args, {
    cwd: options.cwd,
    env: buildEnv(options.env),
    stdio: options.input ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  })
  if (options.input && subprocess.stdin) {
    subprocess.stdin.write(options.input)
    subprocess.stdin.end()
  }
  const exited = new Promise<number>((resolve, reject) => {
    subprocess.once('error', reject)
    subprocess.once('close', (code) => resolve(code ?? 0))
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    exited,
    readNodeStream(subprocess.stdout, options.onOutput),
    readNodeStream(subprocess.stderr, options.onOutput),
  ])
  return buildResult(command, args, options, started, exitCode, stdout, stderr)
}

const runCommandWithBun = async (
  command: string,
  args: string[],
  options: RunCommandOptions,
  started: number,
): Promise<CommandResult> => {
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
  return buildResult(command, args, options, started, exitCode, stdout, stderr)
}

export const runCommand = async (
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> => {
  const started = Date.now()
  const result =
    typeof Bun === 'undefined'
      ? await runCommandWithNode(command, args, options, started)
      : await runCommandWithBun(command, args, options, started)
  throwIfFailed(result, options.allowFailure)
  return result
}

export const runShell = async (script: string, options: RunCommandOptions = {}) =>
  await runCommand('bash', ['-lc', script], options)
