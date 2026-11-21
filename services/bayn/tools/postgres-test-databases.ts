import { SQL } from 'bun'

export const localPostgresTestUrl = (value: string | undefined): URL => {
  if (value === undefined) throw new Error('Missing isolated PostgreSQL shard database')

  const url = new URL(value)
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !url.pathname.endsWith('_test') ||
    url.searchParams.has('host') ||
    url.searchParams.has('dbname')
  ) {
    throw new Error('PostgreSQL file isolation requires a local _test database')
  }
  return url
}

export const postgresFilePrefix = (value: string | undefined): string => {
  if (value === undefined || !/^bayn_file_[a-f0-9]{32}_$/.test(value))
    throw new Error('Missing PostgreSQL test run prefix')
  return value
}

export const removePostgresTestDatabases = async (url: URL, prefix: string): Promise<void> => {
  const runPrefix = postgresFilePrefix(prefix)
  const admin = new SQL({ url: url.toString(), max: 1 })
  try {
    const databases = await admin<readonly { readonly datname: string }[]>`
      SELECT datname FROM pg_database WHERE starts_with(datname, ${runPrefix})
    `
    for (const { datname } of databases) await admin`DROP DATABASE IF EXISTS ${admin(datname)} WITH (FORCE)`
  } finally {
    await admin.close()
  }
}
