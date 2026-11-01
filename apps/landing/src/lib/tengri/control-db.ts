import 'server-only'

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Pool } from 'pg'
import { z } from 'zod'
import { OfzError } from './ofz'

let pool: Pool | undefined
let configuration: string | undefined
let verified: Promise<Pool> | undefined

export function controlDatabase(): Promise<Pool> {
  const dsn = process.env.TENGRI_DATABASE_DSN?.trim()
  const passwordFile = process.env.TENGRI_DATABASE_PASSWORD_FILE?.trim()
  const caFile = process.env.TENGRI_DATABASE_CA_FILE?.trim()
  if (!dsn || !passwordFile || !caFile) throw new OfzError(503)
  const url = new URL(dsn)
  if (
    !['postgresql:', 'postgres:'].includes(url.protocol) ||
    url.password ||
    url.pathname !== '/tengri_control' ||
    url.search ||
    url.hash ||
    !url.hostname ||
    url.username !== 'tengri_bff'
  )
    throw new OfzError(503)
  const password = readFileSync(passwordFile, 'utf8').trimEnd()
  const ca = readFileSync(caFile, 'utf8')
  const nextConfiguration = createHash('sha256')
    .update(JSON.stringify([dsn, password, ca]))
    .digest('hex')
  if (verified && configuration === nextConfiguration) return verified
  const previous = pool
  pool = new Pool({
    host: url.hostname,
    port: Number(url.port || '5432'),
    database: 'tengri_control',
    user: 'tengri_bff',
    password,
    ssl: { ca, rejectUnauthorized: true, servername: url.hostname },
    max: 8,
    connectionTimeoutMillis: 500,
    idleTimeoutMillis: 30_000,
    query_timeout: 2000,
    statement_timeout: 2000,
    lock_timeout: 1000,
    idle_in_transaction_session_timeout: 5000,
    application_name: 'tengri-bff',
  })
  pool.on('error', () => {
    process.emitWarning('An idle Tengri control database connection failed.', {
      code: 'TENGRI_CONTROL_DB_IDLE_FAILURE',
    })
  })
  configuration = nextConfiguration
  void previous
    ?.end()
    .catch(() =>
      process.emitWarning('Retired Tengri database pool cleanup failed.', { code: 'TENGRI_CONTROL_DB_CLOSE_FAILURE' }),
    )
  const current = pool
  const migrationDirectory = path.resolve(process.cwd(), '../../services/tengri/migrations')
  const expected = [
    '0001_control.sql',
    '0002_replay_buckets.sql',
    '0003_replay_slots.sql',
    '0004_leadership_window.sql',
    '0005_capability_slots.sql',
    '0006_preview_lease_identity.sql',
    '0007_ephemeral_oauth.sql',
  ].map((file) =>
    createHash('sha256')
      .update(readFileSync(path.join(migrationDirectory, file)))
      .digest(),
  )
  verified = current
    .query<{ version: unknown; checksum: unknown }>(
      'SELECT version,checksum FROM tengri.schema_version ORDER BY version',
    )
    .then((result) => {
      const rows = z.array(z.object({ version: z.number().int(), checksum: z.instanceof(Buffer) })).parse(result.rows)
      if (
        rows.length !== expected.length ||
        rows.some((row, index) => row.version !== index + 1 || !row.checksum.equals(expected[index]))
      )
        throw new OfzError(503)
      return current
    })
    .catch(() => {
      if (pool === current) {
        verified = undefined
        pool = undefined
      }
      void current.end().catch(() =>
        process.emitWarning('Failed Tengri database pool cleanup failed.', {
          code: 'TENGRI_CONTROL_DB_CLOSE_FAILURE',
        }),
      )
      throw new OfzError(503)
    })
  return verified
}

export function hashOpaque(value: string) {
  return createHash('sha256').update(value).digest()
}
