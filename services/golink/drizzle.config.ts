import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/schema/links.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // Match the local docker-compose port/user so migrations run without extra env
    url: process.env.GOLINK_DATABASE_URL ?? 'postgres://golink:golink@localhost:15433/golink?sslmode=disable',
  },
})
