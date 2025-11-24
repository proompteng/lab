import { spawn } from 'node:child_process'

export interface AppServerHandle {
  process: ReturnType<typeof spawn>
  ready: Promise<void>
}

export const startAppServer = (_binaryPath = 'codex', _workingDirectory?: string): AppServerHandle => {
  // TODO(jng-060b): spawn long-lived `codex app-server` child, perform initialize handshake, surface JSON-RPC send method
  const child = spawn('true')
  return { process: child, ready: Promise.resolve() }
}

export const stopAppServer = async (handle: AppServerHandle): Promise<void> => {
  handle.process.kill()
}
