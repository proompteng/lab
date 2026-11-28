import { sql, type Kysely } from 'kysely'
import type { AgentsDatabase } from '../db'
import { normalizeMemoryNoteMetadata } from '@proompteng/agent-contracts'
import { resolveMemoryNoteSave } from '../memory-note-save'

export const up = async (db: Kysely<AgentsDatabase>) => {
  await sql`ALTER TABLE memories.entries ADD COLUMN save_key text UNIQUE`.execute(db)
  const notes = await db
    .selectFrom('memories.entries')
    .select(['id', 'task_name', 'content', 'summary', 'tags', 'metadata'])
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute()
  const keys = new Set<string>()
  const updates = []
  for (const note of notes) {
    if (!note.content.trim()) continue
    const { saveKey } = resolveMemoryNoteSave({
      namespace: note.task_name,
      content: note.content,
      summary: note.summary,
      tags: note.tags,
      metadata: normalizeMemoryNoteMetadata(note.metadata),
    })
    // Historical duplicates retain their rows; the earliest note owns the replay key.
    if (keys.has(saveKey)) continue
    keys.add(saveKey)
    updates.push(sql`(${note.id}::uuid, ${saveKey}::text)`)
  }
  if (updates.length)
    await sql`UPDATE memories.entries AS e SET save_key = v.key
    FROM (VALUES ${sql.join(updates)}) AS v(id, key) WHERE e.id = v.id`.execute(db)
}
