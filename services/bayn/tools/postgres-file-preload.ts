import { SQL } from 'bun'
import { afterAll } from 'bun:test'
import { localPostgresTestUrl, postgresFilePrefix } from './postgres-test-databases'

const url = localPostgresTestUrl(process.env['BAYN_TEST_POSTGRES_URL'])
const prefix = postgresFilePrefix(process.env['BAYN_TEST_POSTGRES_FILE_PREFIX'])

const database = `${prefix}${crypto.randomUUID().replaceAll('-', '').slice(0, 14)}_test`
const admin = new SQL({ url: url.toString(), max: 1 })
try {
  await admin`CREATE DATABASE ${admin(database)} TEMPLATE template0`
} catch (error) {
  await admin.close()
  throw error
}

// Bun runs isolated preloads before the file reads its environment and tears them down after its own hooks.
afterAll(async () => {
  try {
    await admin`DROP DATABASE ${admin(database)} WITH (FORCE)`
  } finally {
    await admin.close()
  }
})
url.pathname = `/${database}`
process.env['BAYN_TEST_POSTGRES_URL'] = url.toString()
