import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asc, eq } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool, type PoolConfig } from 'pg'
import type { OrchestrationState, TurnSnapshot, WorkerTaskResult } from '../types/orchestration'
import { orchestrations, schema, turns, workerPRs } from './schema'

export interface DbClient {
  upsertOrchestration: (state: OrchestrationState) => Promise<void>
  appendTurn: (orchestrationId: string, snapshot: TurnSnapshot) => Promise<void>
  appendWorkerResult: (orchestrationId: string, result: WorkerTaskResult) => Promise<void>
  getState: (orchestrationId: string) => Promise<OrchestrationState | null>
}

let pool: Pool | null = null
let db: NodePgDatabase<typeof schema> | null = null
let migrationsPromise: Promise<void> | null = null

const getEnv = () => ({
  databaseUrl: Bun.env.DATABASE_URL,
  sslRootCert: Bun.env.PGSSLROOTCERT,
})

const createPool = async () => {
  if (pool) return pool

  const { databaseUrl, sslRootCert } = getEnv()
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to initialize the database client')
  }

  const config: PoolConfig = {
    connectionString: databaseUrl,
  }

  if (sslRootCert) {
    const ca = await readFile(sslRootCert, 'utf8').catch((error) => {
      throw new Error(`Failed to read PGSSLROOTCERT at ${sslRootCert}: ${error.message}`)
    })
    config.ssl = { ca, rejectUnauthorized: true }
  }

  pool = new Pool(config)
  return pool
}

const getDb = async () => {
  if (db) return db
  const createdPool = await createPool()
  db = drizzle(createdPool, { schema })
  return db
}

export const runMigrations = async () => {
  if (migrationsPromise) return migrationsPromise

  migrationsPromise = (async () => {
    const database = await getDb()
    const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle')
    try {
      console.info('[db] Running migrations from', migrationsFolder)
      await migrate(database, { migrationsFolder })
      console.info('[db] Migrations complete')
    } catch (error) {
      console.error('[db] Migration failure', error)
      throw error
    }
  })()

  return migrationsPromise
}

const toDate = (value: string | Date) => (value instanceof Date ? value : new Date(value))

export const createDbClient = async (): Promise<DbClient> => {
  const database = await getDb()

  const upsertOrchestration = async (state: OrchestrationState) => {
    await database
      .insert(orchestrations)
      .values({
        id: state.id,
        topic: state.topic,
        repoUrl: state.repoUrl ?? null,
        status: state.status,
        createdAt: toDate(state.createdAt),
        updatedAt: toDate(state.updatedAt),
      })
      .onConflictDoUpdate({
        target: orchestrations.id,
        set: {
          topic: state.topic,
          repoUrl: state.repoUrl ?? null,
          status: state.status,
          updatedAt: toDate(state.updatedAt),
        },
      })
  }

  const appendTurn = async (orchestrationId: string, snapshot: TurnSnapshot) => {
    await database
      .insert(turns)
      .values({
        orchestrationId,
        index: snapshot.index,
        threadId: snapshot.threadId,
        finalResponse: snapshot.finalResponse,
        items: snapshot.items,
        usage: snapshot.usage,
        createdAt: toDate(snapshot.createdAt),
      })
      .onConflictDoUpdate({
        target: [turns.orchestrationId, turns.index],
        set: {
          threadId: snapshot.threadId,
          finalResponse: snapshot.finalResponse,
          items: snapshot.items,
          usage: snapshot.usage,
        },
      })
  }

  const appendWorkerResult = async (orchestrationId: string, result: WorkerTaskResult) => {
    await database.insert(workerPRs).values({
      orchestrationId,
      prUrl: result.prUrl ?? null,
      branch: result.branch ?? null,
      commitSha: result.commitSha ?? null,
      notes: result.notes ?? null,
    })
  }

  const getState = async (orchestrationId: string): Promise<OrchestrationState | null> => {
    const orchestration = await database.query.orchestrations.findFirst({
      where: eq(orchestrations.id, orchestrationId),
    })

    if (!orchestration) {
      return null
    }

    const [turnRows, workerRows] = await Promise.all([
      database.query.turns.findMany({
        where: eq(turns.orchestrationId, orchestrationId),
        orderBy: asc(turns.index),
      }),
      database.query.workerPRs.findMany({
        where: eq(workerPRs.orchestrationId, orchestrationId),
        orderBy: asc(workerPRs.createdAt),
      }),
    ])

    return {
      id: orchestration.id,
      topic: orchestration.topic,
      repoUrl: orchestration.repoUrl ?? undefined,
      status: orchestration.status,
      turns: turnRows.map((turn) => ({
        index: turn.index,
        threadId: turn.threadId ?? null,
        finalResponse: turn.finalResponse,
        items: turn.items,
        usage: turn.usage,
        createdAt: turn.createdAt.toISOString(),
      })),
      workerPRs: workerRows.map((worker) => ({
        prUrl: worker.prUrl ?? undefined,
        branch: worker.branch ?? undefined,
        commitSha: worker.commitSha ?? undefined,
        notes: worker.notes ?? undefined,
      })),
      createdAt: orchestration.createdAt.toISOString(),
      updatedAt: orchestration.updatedAt.toISOString(),
    }
  }

  return {
    upsertOrchestration,
    appendTurn,
    appendWorkerResult,
    getState,
  }
}
