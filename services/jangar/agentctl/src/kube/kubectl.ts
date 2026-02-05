export type KubectlOptions = {
  kubeconfig?: string
  context?: string
  namespace?: string
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

const defaultRunner: KubectlRunner = async (args, options, stdin) => {
  const proc = Bun.spawn(['kubectl', ...buildKubectlArgs(options), ...args], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (stdin) {
    proc.stdin.write(stdin)
  }
  proc.stdin.end()

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return { stdout, stderr, exitCode }
}

let runner: KubectlRunner = defaultRunner

export const setKubectlRunner = (next: KubectlRunner) => {
  runner = next
}

export const resetKubectlRunner = () => {
  runner = defaultRunner
}

export const runKubectl = (args: string[], options: KubectlOptions, stdin?: string) => runner(args, options, stdin)

export const runKubectlJson = async <T>(args: string[], options: KubectlOptions, stdin?: string): Promise<T> => {
  const result = await runKubectl(args, options, stdin)
  const stdout = result.stdout.trim()
  const stderr = result.stderr.trim()
  if (result.exitCode !== 0) {
    const message = stderr || stdout || `kubectl ${args.join(' ')} failed`
    throw new KubectlError(message, result.stderr, result.exitCode)
  }
  if (!stdout) {
    throw new KubectlError(`kubectl ${args.join(' ')} returned empty output`, result.stderr, result.exitCode)
  }
  try {
    return JSON.parse(stdout) as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new KubectlError(`kubectl ${args.join(' ')} returned non-JSON output: ${message}`, stdout, result.exitCode)
  }
}
