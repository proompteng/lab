import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type { AuthContext } from './auth'
import type { AgentsShellConfig } from './config'

export const writeAuditLog = (
  config: AgentsShellConfig,
  event: string,
  auth: AuthContext | null,
  payload: Record<string, unknown>,
) => {
  if (!config.auditLogPath) return
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    subject: auth?.subject ?? null,
    email: auth?.email ?? null,
    username: auth?.username ?? null,
    ...payload,
  })
  try {
    mkdirSync(dirname(config.auditLogPath), { recursive: true })
    appendFileSync(config.auditLogPath, `${line}\n`)
  } catch (error) {
    console.warn('[agents-shell] failed to write audit log', error)
  }
}
