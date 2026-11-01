import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

const httpModule = new URL('./http.ts', import.meta.url).pathname
const configModule = new URL('./config.ts', import.meta.url).pathname

describe('Agents Shell process shutdown', () => {
  it.each([
    { signal: 'SIGTERM', stalledRequest: false },
    { signal: 'SIGINT', stalledRequest: false },
    { signal: 'SIGTERM', stalledRequest: true },
  ] as const)('exits cleanly on $signal with stalledRequest=$stalledRequest', async ({ signal, stalledRequest }) => {
    const root = mkdtempSync(join(tmpdir(), 'agents-shell-shutdown-'))
    const child = spawn('bun', [
      '--eval',
      `import { startAgentsShellServer } from ${JSON.stringify(httpModule)};
       import { defaultAgentsShellConfigFromEnv } from ${JSON.stringify(configModule)};
       startAgentsShellServer({ ...defaultAgentsShellConfigFromEnv({ AGENTS_SHELL_WORKSPACE_ROOT: ${JSON.stringify(root)} }), host: '127.0.0.1', port: 0 });`,
    ])
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    let socket: ReturnType<typeof connect> | undefined
    try {
      await vi.waitFor(() => expect(stdout, stderr).toContain('agents-shell MCP listening'), { timeout: 5_000 })
      const { port } = JSON.parse(stdout.split('\n')[0]!) as { port: number }
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1_000) })
      expect(await response.json()).toEqual({ ok: true })
      if (stalledRequest) {
        socket = connect(port, '127.0.0.1')
        socket.write(
          'POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n',
        )
        await vi.waitFor(() => expect(stdout).toContain('"phase":"transport"'))
      }
      expect(child.kill(signal)).toBe(true)
      await vi.waitFor(() => expect(child.exitCode, stderr).toBe(0), { timeout: 2_000 })
      expect(child.signalCode).toBeNull()
    } finally {
      socket?.destroy()
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await closed
      rmSync(root, { recursive: true, force: true })
    }
  })
})
