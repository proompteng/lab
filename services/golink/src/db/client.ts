import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { loadEnv } from '../env'
import * as schema from './schema/links'

export type Database = ReturnType<typeof drizzlePg<typeof schema>>
export type TestDatabase = ReturnType<typeof drizzlePglite<typeof schema>>

const globalForDb: { client?: ReturnType<typeof postgres>; db?: Database } = globalThis as never

export const getDb = () => {
  loadEnv()

  if (globalForDb.db) {
    return globalForDb.db
  }

  const databaseUrl = process.env.GOLINK_DATABASE_URL
  if (!databaseUrl) {
    throw new Error('GOLINK_DATABASE_URL is required to run golink')
  }

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
