import { $ } from 'bun'

const USER = 'cerebrum'
const DATABASE = 'cerebrum'
const PASSWORD = 'cerebrum'
const DEFAULT_DATABASE_URL = `postgres://${USER}:${PASSWORD}@localhost:5432/${DATABASE}?sslmode=disable`

const ROLE_QUERY = `SELECT 1 FROM pg_roles WHERE rolname = '${USER}'`
const DATABASE_QUERY = `SELECT 1 FROM pg_database WHERE datname = '${DATABASE}'`

async function existsRole() {
  const raw = await $`psql -tAc ${ROLE_QUERY}`.text()
  return raw.trim() === '1'
}

async function existsDatabase() {
  const raw = await $`psql -tAc ${DATABASE_QUERY}`.text()
  return raw.trim() === '1'
}

async function main() {
  console.log('Bootstrapping local Postgres role/database...')

  if (!(await existsRole())) {
    console.log(`creating role ${USER}`)
    const createRoleSql = `CREATE ROLE ${USER} WITH LOGIN PASSWORD '${PASSWORD}'`
    await $`psql -c ${createRoleSql}`
  } else {
    console.log(`role ${USER} already exists`)
  }

  console.log(`ensuring ${USER} password is current`)
  const alterRoleSql = `ALTER ROLE ${USER} WITH PASSWORD '${PASSWORD}'`
  await $`psql -c ${alterRoleSql}`

  if (!(await existsDatabase())) {
    console.log(`creating database ${DATABASE}`)
    await $`createdb -O ${USER} ${DATABASE}`
  } else {
    console.log(`database ${DATABASE} already exists`)
  }

  console.log(`Bootstrap complete; use DATABASE_URL=${DEFAULT_DATABASE_URL} when running locally`)
}

main().catch((error) => {
  console.error('failed to initialize the cerebrum database:', error)
  process.exit(1)
})
