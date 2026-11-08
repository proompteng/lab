import { type Kysely, sql } from 'kysely'
import type { AgentsDatabase } from '../db'

export const up = async (db: Kysely<AgentsDatabase>) => {
  await sql`CREATE TABLE agent_run_relay_submissions (
    operation_id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL,
    target_id TEXT NOT NULL,
    client_service TEXT NOT NULL,
    actor TEXT NOT NULL,
    authorization_receipt_id UUID NOT NULL,
    request_hash TEXT NOT NULL,
    request_payload JSONB NOT NULL,
    run_name TEXT NOT NULL,
    projection_id UUID REFERENCES agent_runs(id),
    rejection JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`.execute(db)
  await sql`CREATE INDEX agent_run_relay_target_created ON agent_run_relay_submissions(workspace_id, target_id, created_at DESC)`.execute(
    db,
  )
}
export const down = async (_db: Kysely<AgentsDatabase>) => {}
