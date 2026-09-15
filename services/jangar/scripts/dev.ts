export {}

const cwd = process.cwd()
const port = process.env.JANGAR_PORT ?? '3000'
const apiPort = process.env.JANGAR_API_PORT ?? '3001'

const sharedEnv = {
  ...process.env,
  JANGAR_PORT: port,
  JANGAR_API_PORT: apiPort,
}

const client = Bun.spawn(['bun', '--bun', 'vite', 'dev', '--config', 'vite.config.ts', '--host', '--port', port], {
  cwd,
  env: sharedEnv,
  stdout: 'inherit',
  stderr: 'inherit',
})

const server = Bun.spawn(['bun', '--hot', 'src/server/dev.ts'], {
  cwd,
  env: {
    ...sharedEnv,
    PORT: apiPort,
  },
  stdout: 'inherit',
  stderr: 'inherit',
})

const killChildren = () => {
  server.kill()
  client.kill()
}

process.on('SIGINT', killChildren)
process.on('SIGTERM', killChildren)

const firstExit = await Promise.race([
  client.exited.then((code) => ({ code, source: 'client' as const })),
  server.exited.then((code) => ({ code, source: 'server' as const })),
])

killChildren()
await Promise.allSettled([client.exited, server.exited])

if (firstExit.code !== 0) {
  console.error(`[jangar-dev] ${firstExit.source} exited with code ${firstExit.code}`)
  process.exit(firstExit.code)
}
