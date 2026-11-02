import { expect, test } from 'bun:test'

import { runCommandIsolated } from './command-runner'

test('isolated commands do not block the worker event loop', async () => {
  let timerFired = false
  const command = runCommandIsolated(['sh', '-c', 'sleep 0.15; printf done'], process.cwd(), 1_000)

  await new Promise<void>((resolve) => {
    setTimeout(() => {
      timerFired = true
      resolve()
    }, 20)
  })

  expect(timerFired).toBe(true)
  expect(await command).toMatchObject({ exitCode: 0, stdout: 'done', stderr: '' })
})

test('isolated commands enforce their subprocess timeout', async () => {
  const startedAt = Date.now()
  const result = await runCommandIsolated(['sh', '-c', 'sleep 2'], process.cwd(), 50)

  expect(result.exitCode).toBeNull()
  expect(Date.now() - startedAt).toBeLessThan(1_000)
})

test('isolated command timeouts stop the entire process group', async () => {
  const result = await runCommandIsolated(
    ['sh', '-c', 'sleep 10 & child=$!; printf "$child"; wait "$child"'],
    process.cwd(),
    50,
  )
  const childPid = Number.parseInt(result.stdout, 10)

  expect(result.exitCode).toBeNull()
  expect(Number.isSafeInteger(childPid)).toBe(true)
  const probe = Bun.spawnSync(['ps', '-o', 'stat=', '-p', String(childPid)], { stdout: 'pipe', stderr: 'pipe' })
  const state = probe.stdout.toString().trim()
  expect(state === '' || state.startsWith('Z')).toBe(true)
})
