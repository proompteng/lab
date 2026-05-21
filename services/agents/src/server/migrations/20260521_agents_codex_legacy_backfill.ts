import { type Kysely } from 'kysely'

import type { AgentsDatabase } from '../db'

// Retained only so already-applied production migration history remains stable.
// Agents no longer reads legacy host application Codex projection tables at startup.
export const up = async (_db: Kysely<AgentsDatabase>) => {}

export const down = async (_db: Kysely<AgentsDatabase>) => {}
