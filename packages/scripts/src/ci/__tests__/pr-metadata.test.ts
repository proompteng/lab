import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('PR metadata names every violation and binds queued checks to the exact candidate and PR head', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'pr-metadata-'))
  const write = (name: string, document: unknown) => writeFileSync(join(fixture, name), JSON.stringify(document))
  const prHead = 'a'.repeat(40)
  const queueHead = 'b'.repeat(40)
  const priorCommit = 'c'.repeat(40)
  const validTitle = 'ci(queue): verify exact revisions'
  const validSubject = 'test(queue): prove metadata coverage'
  const invalidTitle = 'Wrong title'
  const invalidSubject = 'Wrong commit'

  try {
    writeFileSync(
      join(fixture, 'gh'),
      '#!/bin/sh\ncase "$*" in *mergeQueue*) cat "$METADATA_FIXTURE/queue";; *) cat "$METADATA_FIXTURE/commits";; esac\n',
      { mode: 0o700 },
    )
    writeFileSync(join(fixture, 'git'), '#!/bin/sh\nprintf "%s\\n" "$SQUASH_SUBJECT"\n', { mode: 0o700 })
    const run = (event: 'pull_request' | 'merge_group', squash = validTitle) => {
      const result = Bun.spawnSync(['bash', '.github/scripts/validate-pr-metadata.sh'], {
        env: {
          PATH: `${fixture}:${process.env.PATH ?? ''}`,
          METADATA_FIXTURE: fixture,
          GITHUB_REPOSITORY: 'proompteng/lab',
          GITHUB_SHA: queueHead,
          GITHUB_EVENT_NAME: event,
          GITHUB_EVENT_PATH: join(fixture, 'event'),
          SQUASH_SUBJECT: squash,
        },
      })
      return { exit: result.exitCode, output: `${result.stdout}${result.stderr}` }
    }
    const page = (headRefOid: string, oid: string, message: string) => ({
      data: {
        repository: { pullRequest: { headRefOid, commits: { totalCount: 2, nodes: [{ commit: { oid, message } }] } } },
      },
    })
    write('event', { pull_request: { number: 42, title: invalidTitle, head: { sha: prHead } } })
    write('commits', [page(prHead, priorCommit, validSubject), page(prHead, prHead, invalidSubject)])
    const rejected = run('pull_request')
    expect(rejected.exit).toBe(1)
    expect(rejected.output).toContain(`Invalid PR title: ${invalidTitle}`)
    expect(rejected.output).toContain(`Invalid commit subject: ${invalidSubject}`)

    write('event', { merge_group: { base_ref: 'refs/heads/main', head_sha: queueHead } })
    const entry = (oid: string) => ({
      headCommit: { oid },
      pullRequest: { number: 42, title: validTitle, headRefOid: prHead },
    })
    write('queue', [
      { data: { repository: { mergeQueue: { entries: { nodes: [entry(priorCommit), entry(queueHead)] } } } } },
    ])
    write('commits', [page(prHead, priorCommit, validSubject), page(prHead, prHead, validSubject)])
    expect(run('merge_group').exit).toBe(0)
    expect(run('merge_group', 'Invalid squash').output).toContain('Invalid queued squash subject: Invalid squash')

    write('commits', [page(prHead, priorCommit, validSubject), page(priorCommit, prHead, validSubject)])
    expect(run('merge_group')).toMatchObject({
      exit: 5,
      output: expect.stringContaining('head changed during validation'),
    })

    write('queue', [{ data: { repository: { mergeQueue: { entries: { nodes: [entry(priorCommit)] } } } } }])
    expect(run('merge_group')).toMatchObject({ exit: 5, output: expect.stringContaining('No unique pull request') })
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
