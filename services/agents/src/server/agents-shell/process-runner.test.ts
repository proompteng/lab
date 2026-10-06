import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { auditStdout } from './audit'
import { defaultAgentsShellConfigFromEnv } from './config'
import { formatCommand } from './process-runner'
import { AgentsShellRunner } from './runner'

it('shutdown terminates an active native process group', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agents-shell-native-shutdown-'))
  const pidFile = join(root, 'pid')
  const runner = new AgentsShellRunner(defaultAgentsShellConfigFromEnv({ AGENTS_SHELL_WORKSPACE_ROOT: root }))
  const audit = vi.spyOn(auditStdout, 'write').mockImplementation(() => true)
  let pid = 0
  let finished = false
  const pending = runner
    .runProcess({
      command: '/bin/bash',
      args: ['-c', 'echo $$ > "$1"; exec sleep 120', 'shutdown-test', pidFile],
      cwd: root,
      timeoutSeconds: 180,
      auditEvent: 'shutdown_test',
      auth: { subject: 'shutdown-test', email: null, username: null, scopes: new Set(), payload: {} },
    })
    .then((result) => {
      finished = true
      return result
    })
  try {
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true))
    pid = Number(readFileSync(pidFile, 'utf8').trim())
    runner.shutdown()
    await vi.waitFor(() => expect(finished).toBe(true), { timeout: 2_000 })
    expect(await pending).toMatchObject({ signal: 'SIGKILL', timedOut: false })
  } finally {
    if (pid && !finished) process.kill(-pid, 'SIGKILL')
    await pending
    audit.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
})

describe('command display argument boundaries', () => {
  it('rejects a native process after shutdown without executing it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agents-shell-native-admission-'))
    const marker = join(root, 'started-after-shutdown')
    const runner = new AgentsShellRunner(defaultAgentsShellConfigFromEnv({ AGENTS_SHELL_WORKSPACE_ROOT: root }))
    const audit = vi.spyOn(auditStdout, 'write').mockImplementation(() => true)
    try {
      runner.shutdown()
      await expect(
        runner.runProcess({
          command: '/bin/bash',
          args: ['-c', 'printf late > "$1"', 'shutdown-test', marker],
          cwd: root,
          auditEvent: 'shutdown_test',
          auth: { subject: 'shutdown-test', email: null, username: null, scopes: new Set(), payload: {} },
        }),
      ).rejects.toThrow('shutting down')
      expect(existsSync(marker)).toBe(false)
    } finally {
      audit.mockRestore()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('round trips punctuation, whitespace, quotes, expansions and empty argv through shell words', () => {
    const args = [
      'ordinary',
      '',
      'space value',
      'left;right|tail&last',
      "single'quote",
      'double"quote',
      'back\\slash',
      '$NOT_EXPANDED',
      'line\nbreak',
      '--from-literal=registry=left;right',
    ]
    const display = formatCommand('fixture', args)
    const result = spawnSync('/bin/sh', ['-c', `set -- ${display}; printf '%s\\0' "$@"`], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout.split('\0').slice(0, -1)).toEqual(['fixture', ...args])
    expect(args[3]).toBe('left;right|tail&last')
  })

  it('retains ordinary command display without extra quoting', () => {
    expect(formatCommand('kubectl', ['get', 'pods', '-n', 'agents'])).toBe('kubectl get pods -n agents')
  })
})
