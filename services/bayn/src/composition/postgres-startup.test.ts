import { expect, test } from 'bun:test'

test('production PostgreSQL resource makes exactly three actual connection attempts on persistent refusal', async () => {
  const child = Bun.spawn(['bun', `${import.meta.dir}/postgres-startup.test-support.ts`], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
  const line = stdout.split('\n').find((value) => value.startsWith('POSTGRES_STARTUP_RESULT='))
  if (line === undefined) throw new Error(`PostgreSQL startup worker returned no result: ${stdout}`)
  expect(JSON.parse(line.slice('POSTGRES_STARTUP_RESULT='.length))).toEqual({ attempts: 3 })
}, 15_000)
