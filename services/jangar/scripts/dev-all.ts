type Managed = {
  name: string
  proc: Bun.Subprocess
}

const managed: Managed[] = []
let shuttingDown = false

const bunBin = process.execPath

const colors: Record<string, string> = {
  convex: '\u001b[33m',
  app: '\u001b[36m',
  worker: '\u001b[35m',
  codex: '\u001b[32m',
}
const reset = '\u001b[0m'

const prefixLines = (text: string, label: string, color: string) =>
  text
    .split(/\r?\n/)
    .filter((line) => line.length)
    .map((line) => `${color}[${label}]${reset} ${line}`)
    .join('\n')

const pipeOutput = async (stream: ReadableStream | null, label: string, color: string) => {
  if (!stream) return
  const decoder = new TextDecoder()
  let buffer = ''
  const reader = stream.getReader()

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) {
      buffer += decoder.decode(value as BufferSource, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      if (lines.length) console.log(prefixLines(lines.join('\n'), label, color))
    }
  }

  buffer += decoder.decode()
  if (buffer.length) console.log(prefixLines(buffer, label, color))
}

const runManaged = (name: string, cmd: string[], env: Record<string, string> = {}) => {
  const proc = Bun.spawn({
    cmd,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
    // Keep stdin open for long-lived processes (Codex app-server will exit on EOF).
    stdin: name === 'codex' ? 'pipe' : undefined,
  })

  managed.push({ name, proc })

  const color = colors[name] ?? '\u001b[32m'
  void pipeOutput(proc.stdout, name, color)
  void pipeOutput(proc.stderr, name, color)

  proc.exited.then((code) => {
    if (shuttingDown) return
    console.error(`${name} exited with code ${code}`)
    shutdown(typeof code === 'number' ? code : 1)
  })

  return proc
}

const shutdown = (code = 0) => {
  if (shuttingDown) return
  shuttingDown = true
  for (const { proc } of managed) {
    if (proc.killed) continue
    // Try graceful first, then force kill after a short grace period to avoid lingering logs.
    proc.kill()
    setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL')
    }, 500)
  }
  // Give kill timers a moment to run before exiting this supervisor process.
  setTimeout(() => process.exit(code), 800)
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`Received ${signal}; shutting down...`)
    shutdown(0)
  })
}

runManaged('convex', [bunBin, 'x', 'convex', 'dev'], {
  CONVEX_AGENT_MODE: 'anonymous',
  CONVEX_DEPLOYMENT: '',
  CONVEX_URL: '',
})

runManaged('app', [bunBin, 'run', 'dev:app'], { SKIP_WORKER: '1' })

runManaged('worker', [bunBin, 'run', 'dev:worker'])

runManaged(
  'codex',
  [
    'codex',
    '--sandbox',
    'danger-full-access',
    '--ask-for-approval',
    'never',
    '--model',
    'gpt-5.1-codex-max',
    'app-server',
  ],
  {
    // Ensure Codex can see the repo during local RPC calls.
    CODEX_CWD: process.cwd(),
  },
)

await Promise.race(managed.map(({ name, proc }) => proc.exited.then(() => name)))

export {}
