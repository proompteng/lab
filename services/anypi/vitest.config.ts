import { defineConfig, resolveRoot } from 'vitest/config'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '../..')

export default defineConfig({
  root,
  test: {
    include: ['services/anypi/src/**/*.test.ts'],
  },
})
