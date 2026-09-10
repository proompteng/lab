export const drizzleConfig = (name: string) => `import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/schema/app.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://${name}:${name}@localhost:5432/${name}?sslmode=disable',
  },
})
`

export const drizzleSchema = `import { integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core'

export const samples = pgTable('samples', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  count: integer('count').default(0).notNull(),
})

export type Sample = typeof samples.$inferSelect
export type NewSample = typeof samples.$inferInsert
`
