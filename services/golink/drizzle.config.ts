import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/schema/links.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.GOLINK_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/golink',
  },
})
