import { rootCertificates } from 'node:tls'
import { expect, test } from 'bun:test'
import { ConfigProvider, Effect, FileSystem, Result } from 'effect'

import { loadAuditPostgresTls } from './audit-bayn-live-profitability'

const ca = rootCertificates[0]
if (ca === undefined) throw new Error('Missing bundled test CA')

const load = (env: Record<string, string>, files: ReadonlyMap<string, string> = new Map()) => {
  const readPaths: string[] = []
  const fallback = FileSystem.makeNoop({})
  return Effect.runPromise(
    loadAuditPostgresTls.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env, preserveEmptyStrings: true })),
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: (path) => {
            readPaths.push(path)
            const data = files.get(path)
            return data === undefined ? fallback.readFileString(path) : Effect.succeed(data)
          },
        }),
      ),
      Effect.result,
      Effect.map((result) => ({ result, readPaths })),
    ),
  )
}

test('audit TLS defaults to the Bayn CA and verifies the connection host', async () => {
  const path = '/var/run/secrets/bayn/postgres/ca.crt'
  expect(await load({}, new Map([[path, ca]]))).toEqual({
    result: Result.succeed({ ca, rejectUnauthorized: true }),
    readPaths: [path],
  })
})

test('audit TLS uses the standby DNS name while dialing a port forward', async () => {
  const path = '/operator/bayn-ca.crt'
  const servername = 'bayn-db-ro.bayn.svc.cluster.local'
  expect(
    await load(
      { BAYN_POSTGRES_TLS: 'true', BAYN_POSTGRES_CA_PATH: path, BAYN_POSTGRES_TLS_SERVERNAME: servername },
      new Map([[path, ca]]),
    ),
  ).toEqual({
    result: Result.succeed({ ca, servername, rejectUnauthorized: true }),
    readPaths: [path],
  })
})

test('explicitly disabling TLS for a local fixture does not read a CA', async () => {
  expect(await load({ BAYN_POSTGRES_TLS: 'false' })).toEqual({
    result: Result.succeed(false),
    readPaths: [],
  })
})

test.each([
  ['missing', undefined],
  ['empty', ''],
  ['malformed', 'not a PEM certificate'],
] as const)('audit TLS fails closed when the CA file is %s', async (_, data) => {
  const path = '/operator/bayn-ca.crt'
  const { readPaths, result } = await load(
    { BAYN_POSTGRES_CA_PATH: path },
    data === undefined ? undefined : new Map([[path, data]]),
  )
  expect(readPaths).toEqual([path])
  expect(result).toMatchObject({
    _tag: 'Failure',
    failure: { _tag: 'AuditDatabaseError', message: expect.stringContaining('BAYN_POSTGRES_CA_PATH') },
  })
})

const invalidSettings: Record<string, string>[] = [
  { BAYN_POSTGRES_TLS: 'maybe' },
  { BAYN_POSTGRES_CA_PATH: '' },
  { BAYN_POSTGRES_TLS_SERVERNAME: ' ' },
]
test.each(invalidSettings)('audit TLS rejects invalid settings before reading files (%j)', async (env) => {
  const { readPaths, result } = await load(env)
  expect(readPaths).toEqual([])
  expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'AuditDatabaseError' } })
})
