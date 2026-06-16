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

// Detect if we're in a Bun runtime environment
const isBun = typeof Bun !== 'undefined'

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

const spawnProcess = (command: string, args: string[], options: RunCommandOptions) => {
  const env = buildEnv(options.env)
  if (isBun) {
    const subprocess = Bun.spawn([command, ...args], {
      cwd: options.cwd,
      env,
      stdin: options.input ? 'pipe' : 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return {
      subprocess,
      exited: subprocess.exited,
      stdout: subprocess.stdout,
      stderr: subprocess.stderr,
    }
  } else {
    const spawn = nodeSpawn(command, args, {
      cwd: options.cwd,
      env,
      stdio: options.input ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    })
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        spawn.stdout?.on('data', (chunk: Buffer) => controller.enqueue(chunk))
        spawn.stdout?.on('end', () => controller.close())
      },
    })
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        spawn.stderr?.on('data', (chunk: Buffer) => controller.enqueue(chunk))
        spawn.stderr?.on('end', () => controller.close())
      },
    })
    const exitedPromise = new Promise<number>((resolve) => {
      spawn.on('close', (code) => resolve(code ?? 0))
      spawn.on('error', () => resolve(1))
    })
    if (options.input) {
      spawn.stdin?.write(options.input)
      spawn.stdin?.end()
    }
    return {
      subprocess: spawn,
      exited: exitedPromise,
      stdout,
      stderr,
    }
  }
}

export const runCommand = async (
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> => {
  const started = Date.now()
  const { subprocess, exited, stdout, stderr } = spawnProcess(command, args, options)
  if (options.input && !isBun) {
    // Input already written for node spawn
  } else if (options.input && isBun) {
    subprocess.stdin?.write(options.input)
    subprocess.stdin?.end()
  }
  const [exitCode, stdoutText, stderrText] = await Promise.all([
    exited,
    readStream(stdout, options.onOutput),
    readStream(stderr, options.onOutput),
  ])
  const result = {
    command,
    args,
    cwd: options.cwd,
    exitCode,
    stdout: stdoutText,
    stderr: stderrText,
    durationMs: Date.now() - started,
  }
  if (exitCode !== 0 && !options.allowFailure) {
    const rendered = [command, ...args].join(' ')
    throw new Error(`command failed (${exitCode}): ${rendered}\n${stderrText || stdoutText}`.trim())
  }
  return result
}

export const runShell = async (script: string, options: RunCommandOptions = {}) =>
  await runCommand('bash', ['-lc', script], options)
