import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it, onTestFinished } from 'vitest'

import { runProcessCommand } from './process-command'

it('does not spawn when the signal is already aborted', async () => {
  const reason = new Error('cancel before spawn')
  await expect(runProcessCommand('/no/such/executable', [], { signal: AbortSignal.abort(reason) })).rejects.toBe(reason)
})

it('collects both pipes through close and times out a running process', async () => {
  await expect(
    runProcessCommand(process.execPath, [
      '-e',
      'console.log("output"); console.error("diagnostic"); process.exitCode = 3',
    ]),
  ).resolves.toEqual({ exitCode: 3, stdout: 'output\n', stderr: 'diagnostic\n' })
  await expect(
    runProcessCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 100 }),
  ).rejects.toMatchObject({ name: 'TimeoutError', message: 'command timed out after 100ms' })
})

it.skipIf(process.platform !== 'linux')(
  'escalates to SIGKILL for descendants even after the leader has closed its pipes',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runner-process-group-'))
    const pidFile = join(dir, 'pid')
    const termFile = join(dir, 'term')
    const script = `
    const { spawn } = require('node:child_process')
    const fs = require('node:fs')
    process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(termFile)}, 'terminated'); process.exit(0) })
    spawn(process.execPath, ['-e', ${JSON.stringify(`
      process.on('SIGTERM', () => {})
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, process.pid.toString())
      setInterval(() => {}, 1000)
    `)}], { stdio: 'ignore' })
  `
    const controller = new AbortController()
    const reason = new Error('test cancellation')
    const result = runProcessCommand(process.execPath, ['-e', script], {
      signal: controller.signal,
      timeoutMs: 5_000,
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    let pid: number | undefined
    onTestFinished(async () => {
      controller.abort(reason)
      await result
      if (pid && isRunning(pid)) process.kill(pid, 'SIGKILL')
      await rm(dir, { recursive: true, force: true })
    })
    const readyDeadline = performance.now() + 2_000
    while (!existsSync(pidFile) && performance.now() < readyDeadline) await delay(10)
    const descendant = Number(await readFile(pidFile, 'utf8'))
    pid = descendant
    expect(descendant).toBeGreaterThan(0)
    controller.abort(reason)
    expect(await result).toBe(reason)
    expect(await readFile(termFile, 'utf8')).toBe('terminated')
    const exitDeadline = performance.now() + 1_000
    while (isRunning(descendant) && performance.now() < exitDeadline) await delay(10)
    expect(isRunning(descendant)).toBe(false)
  },
)

const isRunning = (pid: number) => {
  try {
    // A container's init may not have reaped the terminated orphan yet.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
