import { describe, expect, it } from 'vitest'

import { ensureAtlasCommitAvailable, type GitCommandResult } from '../git-utils'

const commit = '0123456789abcdef0123456789abcdef01234567'
const result = (exitCode: number, stderr = ''): GitCommandResult => ({ exitCode, stdout: '', stderr })

describe('ensureAtlasCommitAvailable', () => {
  it('uses an exact local commit without mutating Git state', async () => {
    const commands: string[][] = []
    const available = await ensureAtlasCommitAvailable(commit, async (args) => {
      commands.push(args)
      return result(0)
    })

    expect(available).toEqual({ ok: true })
    expect(commands).toEqual([['cat-file', '-e', `${commit}^{commit}`]])
  })

  it('fetches the exact indexed commit when a shallow workspace does not contain it', async () => {
    const commands: string[][] = []
    const responses = [result(1), result(0), result(0)]
    const available = await ensureAtlasCommitAvailable(commit, async (args) => {
      commands.push(args)
      return responses.shift() ?? result(1)
    })

    expect(available).toEqual({ ok: true })
    expect(commands).toEqual([
      ['cat-file', '-e', `${commit}^{commit}`],
      ['fetch', '--no-auto-maintenance', '--quiet', '--depth=1', 'origin', commit],
      ['cat-file', '-e', `${commit}^{commit}`],
    ])
  })

  it('fails closed when the exact indexed commit cannot be fetched', async () => {
    const available = await ensureAtlasCommitAvailable(commit, async (args) =>
      args[0] === 'fetch' ? result(1, 'remote rejected commit') : result(1),
    )

    expect(available).toEqual({ ok: false, message: 'remote rejected commit' })
  })

  it('rejects mutable refs and abbreviated SHAs', async () => {
    let called = false
    const available = await ensureAtlasCommitAvailable('main', async () => {
      called = true
      return result(0)
    })

    expect(available).toEqual({ ok: false, message: 'Indexed commit is not an exact Git SHA.' })
    expect(called).toBe(false)
  })
})
