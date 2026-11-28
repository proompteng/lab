import { execFile } from 'node:child_process'

export type KubectlOptions = {
  kubeconfig?: string
  context?: string
  namespace?: string
  signal?: AbortSignal
}

export type KubectlResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export class KubectlError extends Error {
  readonly stderr?: string
  readonly exitCode?: number

  constructor(message: string, stderr?: string, exitCode?: number) {
    super(message)
    this.name = 'KubectlError'
    this.stderr = stderr
    this.exitCode = exitCode
  }
}

export const buildKubectlArgs = (options: KubectlOptions) => {
  const args: string[] = []
  if (options.kubeconfig) {
    args.push('--kubeconfig', options.kubeconfig)
  }
  if (options.context) {
    args.push('--context', options.context)
  }
  if (options.namespace) {
    args.push('-n', options.namespace)
  }
  return args
}

export type KubectlRunner = (args: string[], options: KubectlOptions, stdin?: string) => Promise<KubectlResult>

const defaultRunner: KubectlRunner = (args, options, stdin) =>
  new Promise((resolve, reject) => {
    const proc = execFile(
      'kubectl',
      [...buildKubectlArgs(options), ...args],
      { encoding: 'utf8', maxBuffer: Infinity, signal: options.signal },
      (error, stdout, stderr) => {
        const exitCode = error ? error.code : 0
        if (typeof exitCode !== 'number') {
          reject(error)
          return
        }
        resolve({ stdout, stderr, exitCode })
      },
    )
    proc.stdin?.on('error', reject)
    proc.stdin?.end(stdin)
  })

let runner: KubectlRunner = defaultRunner

export const setKubectlRunner = (next: KubectlRunner) => {
  runner = next
}

export const resetKubectlRunner = () => {
  runner = defaultRunner
}

export const runKubectl = (args: string[], options: KubectlOptions, stdin?: string) => runner(args, options, stdin)

const readJson = async (
  args: string[],
  options: KubectlOptions,
  stdin?: string,
  allowEmpty = false,
): Promise<unknown> => {
  const result = await runKubectl(args, options, stdin)
  const stdout = result.stdout.trim()
  if (result.exitCode !== 0) {
    const message = result.stderr.trim() || `kubectl ${args.slice(0, 2).join(' ')} failed`
    throw new KubectlError(message, result.stderr, result.exitCode)
  }
  if (!stdout) {
    if (allowEmpty) return null
    throw new KubectlError(
      `kubectl ${args.slice(0, 2).join(' ')} returned empty output`,
      result.stderr,
      result.exitCode,
    )
  }
  try {
    return JSON.parse(stdout)
  } catch {
    throw new KubectlError(`kubectl ${args.slice(0, 2).join(' ')} returned invalid JSON`)
  }
}

export const runKubectlJson = async <T>(args: string[], options: KubectlOptions, stdin?: string): Promise<T> =>
  (await readJson(args, options, stdin)) as T

export const runKubectlOptionalJson = (args: string[], options: KubectlOptions) =>
  readJson([...args, '--ignore-not-found'], options, undefined, true)
