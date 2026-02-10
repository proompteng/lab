import { Pool } from 'pg'

type EnabledTorghutDb = { ok: true; pool: Pool }
type DisabledTorghutDb = { ok: false; disabled: true; message: string }

export type TorghutDbResult = EnabledTorghutDb | DisabledTorghutDb

let cachedPool: Pool | null = null

export const resolveTorghutDb = (): TorghutDbResult => {
  const dsn = process.env.TORGHUT_DB_DSN?.trim()
  if (!dsn) {
    return {
      ok: false,
      disabled: true,
      message: 'Torghut trading history is disabled because TORGHUT_DB_DSN is not configured.',
    }
  }

  if (cachedPool) return { ok: true, pool: cachedPool }

  // Do not log the DSN; it may contain secrets.
  cachedPool = new Pool({
    connectionString: dsn,
    max: 2,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
  })

  cachedPool.on('error', () => {
    // Avoid leaking connection strings in logs; reset so subsequent calls can retry.
    cachedPool = null
  })

  return { ok: true, pool: cachedPool }
}
