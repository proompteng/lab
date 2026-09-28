import { type Kysely, sql } from 'kysely'

export const up = async (db: Kysely<any>) => {
  await sql`ALTER TABLE jangar_github.write_actions ADD COLUMN IF NOT EXISTS mission_id text`.execute(db)
  await sql`ALTER TABLE jangar_github.write_actions ADD COLUMN IF NOT EXISTS stage text`.execute(db)
  await sql`ALTER TABLE jangar_github.write_actions ADD COLUMN IF NOT EXISTS action_class text`.execute(db)
  await sql`ALTER TABLE jangar_github.write_actions ADD COLUMN IF NOT EXISTS risk_class text`.execute(db)
  await sql`ALTER TABLE jangar_github.write_actions ADD COLUMN IF NOT EXISTS rollout_ref text`.execute(db)
  await sql`ALTER TABLE jangar_github.write_actions ADD COLUMN IF NOT EXISTS rollout_status text`.execute(db)
  await sql`ALTER TABLE jangar_github.write_actions ADD COLUMN IF NOT EXISTS rollback_ref text`.execute(db)
  await sql`ALTER TABLE jangar_github.write_actions ADD COLUMN IF NOT EXISTS rollback_reason text`.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS jangar_github_write_actions_mission_idx
    ON jangar_github.write_actions (mission_id, received_at DESC)
  `.execute(db)
}

export const down = async () => {}
