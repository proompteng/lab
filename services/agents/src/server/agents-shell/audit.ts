import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

import type { AuthContext } from './auth'
import type { AgentsShellConfig } from './config'

export const writeAuditLog = (
  config: AgentsShellConfig,
  event: string,
  auth: AuthContext | null,
  payload: Record<string, unknown>,
  options: { required?: boolean } = {},
) => {
  if (!config.auditLogPath) {
    if (options.required) throw new Error('durable agents-shell audit log is required')
    return
  }
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    subject: auth?.subject ?? null,
    email: auth?.email ?? null,
    username: auth?.username ?? null,
    ...payload,
  })
  try {
    const directory = dirname(config.auditLogPath)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const fd = openSync(config.auditLogPath, 'a', 0o600)
    try {
      writeSync(fd, `${line}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    const directoryFd = openSync(directory, 'r')
    try {
      fsyncSync(directoryFd)
    } finally {
      closeSync(directoryFd)
    }
  } catch (error) {
    if (options.required) throw error
    console.warn('[agents-shell] failed to write audit log', error)
  }
}
