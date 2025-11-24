import type { OrchestrationState, TurnSnapshot, WorkerTaskResult } from '../types/orchestration'

export interface DbClient {
  upsertOrchestration: (state: OrchestrationState) => Promise<void>
  appendTurn: (orchestrationId: string, snapshot: TurnSnapshot) => Promise<void>
  appendWorkerResult: (orchestrationId: string, result: WorkerTaskResult) => Promise<void>
  getState: (orchestrationId: string) => Promise<OrchestrationState | null>
}

export const createDbClient = async (): Promise<DbClient> => {
  // TODO(jng-020b): wire Drizzle/Postgres connection using DATABASE_URL + PGSSLROOTCERT
  const notImplemented = async () => {
    throw new Error('DB client not implemented')
  }

  return {
    upsertOrchestration: notImplemented,
    appendTurn: notImplemented,
    appendWorkerResult: notImplemented,
    getState: async () => null,
  }
}
