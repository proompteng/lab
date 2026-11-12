import { type Kysely, sql } from 'kysely'

import type { AgentsDatabase } from '../db'

export const up = async (db: Kysely<AgentsDatabase>) => {
  await sql`
    ALTER TABLE memories.entries
      ADD COLUMN retired_at timestamptz,
      ADD COLUMN retirement_reason text,
      ADD COLUMN replacement_id uuid REFERENCES memories.entries(id),
      ADD CONSTRAINT memory_note_retirement CHECK (
        (retired_at IS NULL AND retirement_reason IS NULL AND replacement_id IS NULL)
        OR (retired_at IS NOT NULL AND retirement_reason IS NOT NULL AND length(trim(retirement_reason)) > 0)
      ),
      ADD CONSTRAINT memory_note_replacement CHECK (replacement_id IS DISTINCT FROM id)
  `.execute(db)
  await sql`
    CREATE INDEX memories_entries_current_created_idx ON memories.entries (created_at DESC, id DESC)
    WHERE retired_at IS NULL
  `.execute(db)
  await sql`
    CREATE INDEX memories_entries_search_idx ON memories.entries USING gin (
      to_tsvector('simple', coalesce(summary, '') || ' ' || content)
    ) WHERE retired_at IS NULL
  `.execute(db)
}
