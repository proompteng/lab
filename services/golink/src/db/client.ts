import { resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema/links'
import { loadEnv } from '../env'

export type Database = ReturnType<typeof drizzlePg<typeof schema>>
export type TestDatabase = ReturnType<typeof drizzlePglite<typeof schema>>

const globalForDb: { client?: ReturnType<typeof postgres>; db?: Database } = globalThis as never

const ensureDatabaseExists = async (databaseUrl: string) => {
  try {
    // Quick probe
    const client = postgres(databaseUrl, { max: 1, idle_timeout: 5, connect_timeout: 5 })
    await client`select 1`
    await client.end({ timeout: 1 })
    return
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === '3D000')) {
      throw error
    }
  }

  const url = new URL(databaseUrl)
  const dbName = url.pathname.replace(/^\//, '') || 'postgres'
  url.pathname = '/postgres'
  const admin = postgres(url.toString(), { max: 1, idle_timeout: 5, connect_timeout: 5 })
  try {
    await admin`create database ${postgres(dbName)}`
  } finally {
    await admin.end({ timeout: 1 })
  }
}

export const getDb = () => {
  loadEnv()

  if (globalForDb.db) {
    return globalForDb.db
  }

  const databaseUrl = process.env.GOLINK_DATABASE_URL
  if (!databaseUrl) {
    throw new Error('GOLINK_DATABASE_URL is required to run golink')
  }

  // Ensure the target database exists for local/dev convenience.
  // This is skipped if the DB is reachable.
  // eslint-disable-next-line promise/catch-or-return
  ensureDatabaseExists(databaseUrl).catch((error) => {
    console.error('Failed to ensure database exists', error)
  })

  const client = postgres(databaseUrl, {
    max: 4,
    idle_timeout: 30,
    prepare: true,
  })

  const db = drizzlePg(client, { schema })
  globalForDb.client = client
  globalForDb.db = db
  return db
}

export const createTestDb = async () => {
  const client = new PGlite()
  const db = drizzlePglite(client, { schema })
  const migrationsFolder = resolve(fileURLToPath(new URL('.', import.meta.url)), './migrations')
  await migrate(db, { migrationsFolder })
  return { client, db }
}

export const closeTestDb = async (client?: PGlite) => {
  if (!client) return
  await client.close({ force: true })
}
