import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCodexBootstrap } from '../codex-bootstrap'

const bunMocks = vi.hoisted(() => {
  const execMock = vi.fn(async (_options: { command: string; cwd?: string }) => ({ text: async () => '' }))
  const spawnExitCodeOverrides = new Map<string, number>()
  const resolveSpawnExitCode = (command: string): number => {
    for (const [needle, code] of spawnExitCodeOverrides.entries()) {
      if (command.includes(needle)) {
        return code
      }
    }
    return 0
  }
  const spawnMock = vi.fn((options?: { cmd?: string[] }) => {
    const command = Array.isArray(options?.cmd) ? options?.cmd.join(' ') : ''
    return { exited: Promise.resolve(resolveSpawnExitCode(command)) }
  })
  const whichMock = vi.fn(async (command: string) => command)
  const exitCodeOverrides = new Map<string, number>()
  const isTemplateStringsArray = (value: unknown): value is TemplateStringsArray =>
    Array.isArray(value) && Object.hasOwn(value, 'raw')

  const resolveExitCode = (command: string): number => {
    for (const [needle, code] of exitCodeOverrides.entries()) {
      if (command.includes(needle)) {
        return code
      }
    }
    return 0
  }

  const makeTagged =
    (cwd?: string) =>
    (strings: TemplateStringsArray, ...exprs: unknown[]) => {
      const command = strings.reduce((acc, part, index) => acc + part + (exprs[index] ?? ''), '').trim()
      execMock({ command, cwd })
      const result = {
        exitCode: resolveExitCode(command),
        text: async () => '',
        nothrow: async () => result,
      }
      return result
    }

  const dollar = (...args: unknown[]) => {
    const first = args[0]
    if (isTemplateStringsArray(first)) {
      return makeTagged()(first, ...(args.slice(1) as unknown[]))
    }
    if (typeof first === 'object' && first !== null) {
      const options = first as { cwd?: string }
      return makeTagged(options.cwd)
    }
    throw new Error('Invalid invocation of $ stub')
  }

  return { execMock, spawnMock, whichMock, dollar, exitCodeOverrides, spawnExitCodeOverrides }
})

vi.mock('bun', () => ({
  $: bunMocks.dollar,
  spawn: bunMocks.spawnMock,
  which: bunMocks.whichMock,
}))

const execMock = bunMocks.execMock
const spawnMock = bunMocks.spawnMock
const whichMock = bunMocks.whichMock
const exitCodeOverrides = bunMocks.exitCodeOverrides
const spawnExitCodeOverrides = bunMocks.spawnExitCodeOverrides

const ORIGINAL_ENV = { ...process.env }

const resetEnv = () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key]
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value
  }
}

describe('runCodexBootstrap', () => {
  let workdir: string
  let chdirSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'codex-bootstrap-test-'))
    process.env.WORKTREE = workdir
    process.env.TARGET_DIR = workdir
    process.env.BASE_BRANCH = 'main'
    execMock.mockClear()
    spawnMock.mockClear()
    whichMock.mockClear()
    exitCodeOverrides.clear()
    spawnExitCodeOverrides.clear()
    chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => undefined)
  })

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
    chdirSpy.mockRestore()
    resetEnv()
  })

  it('fetches and resets when the repository already exists', async () => {
    await mkdir(join(workdir, '.git'), { recursive: true })

    const exitCode = await runCodexBootstrap()

    expect(exitCode).toBe(0)
    const commands = execMock.mock.calls.map((call) => call[0]?.command)
    expect(commands).toContain(`git -C ${workdir} fetch --all --prune`)
    expect(commands).toContain(`git -C ${workdir} reset --hard origin/main`)
  })

  it('retries bun install without frozen lockfile when frozen install fails', async () => {
    await mkdir(join(workdir, '.git'), { recursive: true })
    spawnExitCodeOverrides.set('install --frozen-lockfile', 1)

    const exitCode = await runCodexBootstrap()

    expect(exitCode).toBe(0)
    const commands = spawnMock.mock.calls.map((call) => (Array.isArray(call[0]?.cmd) ? call[0].cmd.join(' ') : ''))
    expect(commands).toContain('bun install --frozen-lockfile')
    expect(commands).toContain('bun install --no-cache --backend=copyfile')
  })

  it('clones the repository when the worktree is missing', async () => {
    const repoDir = join(workdir, 'repo')
    process.env.WORKTREE = repoDir
    process.env.TARGET_DIR = repoDir

    const exitCode = await runCodexBootstrap()

    expect(exitCode).toBe(0)
    const commands = execMock.mock.calls.map((call) => call[0]?.command)
    expect(commands.some((command) => command?.includes('gh repo clone'))).toBe(true)
    expect(commands).toContain(`git -C ${repoDir} checkout main`)
    expect(chdirSpy).toHaveBeenCalledWith(repoDir)
  })

  it('runs the requested command and returns its exit code', async () => {
    spawnExitCodeOverrides.set('ls -la', 7)
    await mkdir(join(workdir, '.git'), { recursive: true })

    const exitCode = await runCodexBootstrap(['ls', '-la'])

    expect(whichMock).toHaveBeenCalledWith('ls')
    expect(spawnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: ['ls', '-la'],
        cwd: workdir,
      }),
    )
    expect(exitCode).toBe(7)
  })

  it('configures non-interactive env defaults without overriding explicit values', async () => {
    await mkdir(join(workdir, '.git'), { recursive: true })
    delete process.env.PAGER
    delete process.env.GIT_PAGER
    delete process.env.GIT_TERMINAL_PROMPT
    process.env.LESS = '-R'
    process.env.MANPAGER = 'more'

    await runCodexBootstrap()

    expect(process.env.PAGER).toBe('cat')
    expect(process.env.GIT_PAGER).toBe('cat')
    expect(process.env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(process.env.KUBECTL_PAGER).toBe('cat')
    expect(process.env.SYSTEMD_PAGER).toBe('cat')
    expect(process.env.BAT_PAGER).toBe('cat')
    expect(process.env.MANPAGER).toBe('more')
    expect(process.env.LESS).toContain('R')
    expect(process.env.LESS).toContain('F')
    expect(process.env.LESS).toContain('S')
    expect(process.env.LESS).toContain('X')
  })

  it('falls back to base when the head branch does not exist remotely', async () => {
    await mkdir(join(workdir, '.git'), { recursive: true })
    process.env.HEAD_BRANCH = 'codex/issue-9999-temp'
    exitCodeOverrides.set(`git -C ${workdir} checkout ${process.env.HEAD_BRANCH}`, 1)
    exitCodeOverrides.set(`rev-parse --verify --quiet origin/${process.env.HEAD_BRANCH}`, 1)

    const exitCode = await runCodexBootstrap()

    expect(exitCode).toBe(0)
    const commands = execMock.mock.calls.map((call) => call[0]?.command)
    expect(commands).toContain(`git -C ${workdir} checkout -B ${process.env.HEAD_BRANCH} origin/main`)
    expect(commands).toContain(`git -C ${workdir} reset --hard origin/main`)
  })

  it('resets to base when remote tracking ref is missing even if checkout succeeds', async () => {
    await mkdir(join(workdir, '.git'), { recursive: true })
    process.env.HEAD_BRANCH = 'codex/issue-1234'
    // Simulate remote ref missing; checkout succeeds (default exit 0).
    exitCodeOverrides.set(`rev-parse --verify --quiet origin/${process.env.HEAD_BRANCH}`, 1)

    const exitCode = await runCodexBootstrap()

    expect(exitCode).toBe(0)
    const commands = execMock.mock.calls.map((call) => call[0]?.command)
    // Ensure we don't reset against a non-existent origin/head.
    expect(commands).toContain(`git -C ${workdir} reset --hard origin/main`)
  })

  it('falls back to base reset if resetting against head fails', async () => {
    await mkdir(join(workdir, '.git'), { recursive: true })
    process.env.HEAD_BRANCH = 'codex/issue-5555'
    // Pretend remote head exists so we try it, but make reset fail.
    exitCodeOverrides.set(`git -C ${workdir} reset --hard origin/${process.env.HEAD_BRANCH}`, 128)

    const exitCode = await runCodexBootstrap()

    expect(exitCode).toBe(0)
    const commands = execMock.mock.calls.map((call) => call[0]?.command)
    expect(commands).toContain(`git -C ${workdir} reset --hard origin/${process.env.HEAD_BRANCH}`)
    expect(commands).toContain(`git -C ${workdir} reset --hard origin/main`)
  })
})
