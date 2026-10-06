import { expect, test } from 'bun:test'

test('failed capture disposes lazy broker acquisition before returning measured quota after persistence failure', async () => {
  const child = Bun.spawn(['bun', `${import.meta.dir}/broker-observation-runtime.test-support.ts`], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
  const line = stdout.split('\n').find((value) => value.startsWith('BROKER_POLL_RESULT='))
  if (line === undefined) throw new Error(`Broker poll worker returned no result: ${stdout}`)
  const result = JSON.parse(line.slice('BROKER_POLL_RESULT='.length))
  expect(result.poll._tag).toBe('Unavailable')
  expect(result.attemptsAtReturn).toBe(1)
  expect(result.attemptsAfterReturn).toBe(1)
  expect(result.nextPollNotBeforeMs).toBe(result.poll.nextPollNotBeforeMs)
})
