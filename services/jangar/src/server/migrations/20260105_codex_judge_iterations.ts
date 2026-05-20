import type { Db } from '~/server/db'

export const up = async (_db: Db) => {
  // Codex run projections moved to services/agents. Keep this historical
  // migration name registered without mutating Jangar-owned schemas.
}

export const down = async (_db: Db) => {}
