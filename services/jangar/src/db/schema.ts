import type { ThreadItem, Usage } from '@proompteng/codex'
import { type InferInsertModel, type InferSelectModel, sql } from 'drizzle-orm'
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type { OrchestrationStatus } from '../types/orchestration'

export const orchestrationStatus = pgEnum('orchestration_status', [
  'pending',
  'running',
  'completed',
  'failed',
  'aborted',
])

export const orchestrations = pgTable('orchestrations', {
  id: text('id').primaryKey(),
  topic: text('topic').notNull(),
  repoUrl: text('repo_url'),
  status: orchestrationStatus('status').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => sql`now()`),
})

export const turns = pgTable(
  'turns',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orchestrationId: text('orchestration_id')
      .references(() => orchestrations.id, { onDelete: 'cascade' })
      .notNull(),
    index: integer('index').notNull(),
    threadId: text('thread_id'),
    finalResponse: text('final_response').notNull(),
    items: jsonb('items').$type<ThreadItem[]>().notNull(),
    usage: jsonb('usage').$type<Usage | null>().default(sql`null`),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orchestrationIdIdx: index('turns_orchestration_id_idx').on(table.orchestrationId),
    orchestrationIndexUnique: uniqueIndex('turns_orchestration_index_unique').on(table.orchestrationId, table.index),
  }),
)

export const workerPRs = pgTable(
  'worker_prs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orchestrationId: text('orchestration_id')
      .references(() => orchestrations.id, { onDelete: 'cascade' })
      .notNull(),
    prUrl: text('pr_url'),
    branch: text('branch'),
    commitSha: text('commit_sha'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orchestrationIdIdx: index('worker_prs_orchestration_id_idx').on(table.orchestrationId),
  }),
)

export const schema = {
  orchestrations,
  turns,
  workerPRs,
}

export type OrchestrationStatusColumn = OrchestrationStatus
export type OrchestrationRow = InferSelectModel<typeof orchestrations>
export type NewOrchestrationRow = InferInsertModel<typeof orchestrations>
export type TurnRow = InferSelectModel<typeof turns>
export type WorkerPRRow = InferSelectModel<typeof workerPRs>
