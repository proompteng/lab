import { expect, test } from 'bun:test'

test('PostgreSQL deadline sockets preserve immediate writes, deadlines, TLS and Unix paths', async () => {
  const child = Bun.spawn(['bun', `${import.meta.dir}/postgres-client.test-support.ts`], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
  const line = stdout.split('\n').find((value) => value.startsWith('POSTGRES_SOCKET_RESULT='))
  if (line === undefined) throw new Error(`PostgreSQL socket worker returned no result: ${stdout}`)
  expect(JSON.parse(line.slice('POSTGRES_SOCKET_RESULT='.length))).toEqual({
    cases: ['tcp', 'tls', 'unix'],
    sockets: 6,
  })
})
