import { existsSync, readFileSync } from 'node:fs'
import { SQL } from 'bun'

let db: SQL | null | undefined

export type Db = SQL

const loadCaCert = (rawValue: string) => {
  if (rawValue.includes('BEGIN CERTIFICATE')) {
    return rawValue
  }
  if (existsSync(rawValue)) {
    return readFileSync(rawValue, 'utf8')
  }
  return rawValue
}

export const getDb = () => {
  if (db !== undefined) return db

  const url = process.env.DATABASE_URL?.trim()
  if (!url) {
    db = null
    return db
  }

  const caCertPath = process.env.PGSSLROOTCERT?.trim() || process.env.JANGAR_DB_CA_CERT?.trim()
  const tls = caCertPath ? { ca: loadCaCert(caCertPath) } : undefined

  db = new SQL({
    url,
    tls,
  })
  return db
}
