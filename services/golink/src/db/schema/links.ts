import { index, pgTable, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

export const links = pgTable(
  'links',
  {
    id: serial('id').primaryKey(),
    slug: text('slug').notNull(),
    targetUrl: text('target_url').notNull(),
    title: text('title'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    slugIdx: uniqueIndex('links_slug_idx').on(table.slug),
    createdIdx: index('links_created_idx').on(table.createdAt),
  }),
)

export type Link = typeof links.$inferSelect
export type NewLink = typeof links.$inferInsert
