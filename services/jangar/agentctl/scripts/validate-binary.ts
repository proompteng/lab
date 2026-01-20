import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

const DEFAULT_SERVER = '127.0.0.1:50052'
const DEFAULT_TIMEOUT_MS = 10_000

type Options = {
  binaryPath?: string
  server?: string
  timeoutMs: number
}

const usage = () => {
  console.log(`Usage: bun run scripts/validate-binary.ts [options]

Options:
  --server <addr>   gRPC server address (default: ${DEFAULT_SERVER})
  --binary <path>   agentctl binary path (default: dist/agentctl or AGENTCTL_BINARY)
  --timeout <ms>    timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
`)
}

const parseArgs = (argv: string[]): Options => {
  const options: Options = { timeoutMs: DEFAULT_TIMEOUT_MS }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg) continue
    if (arg === '--server') {
      options.server = argv[++i]
      continue
    }
    if (arg === '--binary') {
      options.binaryPath = argv[++i]
      continue
    }
    if (arg === '--timeout') {
      const value = Number(argv[++i])
      if (Number.isNaN(value) || value <= 0) {
        throw new Error('--timeout must be a positive number')
      }
      options.timeoutMs = value
      continue
    }
    if (arg === '--help' || arg === '-h') {
      usage()
      throw new Error('help requested')
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  return options
}

const resolveBinary = (override?: string) => {
  if (override) return override
  const env = process.env.AGENTCTL_BINARY?.trim()
  if (env) return env
  return resolve(process.cwd(), 'dist', 'agentctl')
}

const main = async () => {
  const options = parseArgs(Bun.argv.slice(2))
  const server = options.server ?? DEFAULT_SERVER
  const binaryPath = resolveBinary(options.binaryPath)

  if (!existsSync(binaryPath)) {
    throw new Error(`agentctl binary not found at ${binaryPath}; run bun run build:bin first`)
  }

  const proc = Bun.spawn([binaryPath, 'version', '--server', server], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const timeout = setTimeout(() => {
    proc.kill()
  }, options.timeoutMs)

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  clearTimeout(timeout)

  if (exitCode !== 0) {
    throw new Error(`agentctl failed with exit code ${exitCode}\n${stderr || stdout}`)
  }

  const output = `${stdout}${stderr}`.trim()
  if (!output.toLowerCase().includes('agentctl') || !output.toLowerCase().includes('server')) {
    throw new Error(`agentctl version output missing server info:\n${output}`)
  }

  console.log('agentctl compiled binary validated')
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
