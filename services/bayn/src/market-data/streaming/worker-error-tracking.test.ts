import { expect, test } from 'bun:test'

test('isolated projection worker initializes private error reporting once and ignores normal interruption', async () => {
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/worker-error-tracking.test-support.ts`], {
    env: {
      PATH: process.env['PATH'],
      BAYN_GLITCHTIP_DSN: 'http://591bd90be7b84b22856ec7c1bd456ec2@glitchtip-web.glitchtip.svc.cluster.local/1',
      NODE_ENV: 'test',
    },
    timeout: 10_000,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code, stderr).toBe(0)
  const line = stdout.split('\n').find((value) => value.startsWith('WORKER_ERROR_RESULT='))
  expect(line, stdout).toBeDefined()
  const result = JSON.parse(line?.slice('WORKER_ERROR_RESULT='.length) ?? '{}')
  expect(result.initializations).toBe(1)
  expect(result.afterFailure).toBe(1)
  expect(result.afterInterruption).toBe(result.afterFailure)
  expect(result.states).toEqual(['INCOMPLETE'])
  expect(result.endings).toEqual(['INCOMPLETE'])
  expect(result.finalized).toBe(2)
  expect(result.interrupted).toEqual([true, true])
  const events = JSON.stringify(result.envelopes)
  expect(events).toContain('bayn-market-projection')
  expect(events).toContain('retention-incomplete')
  expect(events).toContain('bayn.market-data.native-arrival')
  expect(events).not.toContain('private-fixture-payload')
  expect(events).not.toContain('private-token')
  expect(events).not.toContain('captureId')
}, 15_000)
