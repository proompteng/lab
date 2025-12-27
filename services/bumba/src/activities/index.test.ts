import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { activities } from './index'

const runGit = (args: string[], cwd: string) => {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || 'git command failed')
  }
  return result.stdout.toString().trim()
}

const runExtract = async (extension: string, content: string) => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'bumba-'))
  const filename = `sample${extension}`
  const filePath = join(repoRoot, filename)

  try {
    await writeFile(filePath, content, 'utf8')
    return await activities.extractAstSummary({ repoRoot, filePath: filename })
  } finally {
    await rm(repoRoot, { recursive: true, force: true })
  }
}

describe('bumba ast extraction', () => {
  it('parses tree-sitter kotlin files', async () => {
    const result = await runExtract('.kt', 'class Foo {}')
    expect(result.metadata.language).toBe('kotlin')
  })

  it('parses tree-sitter terraform files', async () => {
    const result = await runExtract('.tf', 'resource "test" "example" {}')
    expect(result.metadata.language).toBe('terraform')
  })

  it('parses tree-sitter bash files', async () => {
    const result = await runExtract('.sh', 'echo "hello"')
    expect(result.metadata.language).toBe('bash')
  })

  it('parses embedded template files', async () => {
    const result = await runExtract('.erb', '<%= user.name %>')
    expect(result.metadata.language).toBe('embedded-template')
  })

  it('parses markdown with a custom parser', async () => {
    const result = await runExtract('.md', '# Title\n\nBody')
    expect(result.metadata.parser).toBe('markdown')
  })

  it('parses proto files with a custom parser', async () => {
    const result = await runExtract('.proto', 'message Foo { string bar = 1; }')
    expect(result.metadata.parser).toBe('proto')
  })

  it('parses ini files with a custom parser', async () => {
    const result = await runExtract('.ini', '[section]\nkey=value')
    expect(result.metadata.parser).toBe('ini')
  })

  it('falls back to plain text when no parser exists', async () => {
    const result = await runExtract('.txt', 'Hello world')
    expect(result.metadata.parser).toBe('text')
    expect(result.metadata.language).toBe('text')
  })
})

describe('bumba readRepoFile', () => {
  it('reads file content from git objects when commit is available', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'bumba-'))
    const filePath = 'README.md'
    const content = 'hello from git\n'
    const previousFetch = globalThis.fetch

    try {
      runGit(['init', '-b', 'main'], repoRoot)
      runGit(['config', 'user.email', 'bumba-tests@example.com'], repoRoot)
      runGit(['config', 'user.name', 'Bumba Tests'], repoRoot)
      await writeFile(join(repoRoot, filePath), content, 'utf8')
      runGit(['add', '.'], repoRoot)
      runGit(['commit', '-m', 'init'], repoRoot)
      const commit = runGit(['rev-parse', 'HEAD'], repoRoot)

      const fetchStub = (async () => {
        throw new Error('unexpected fetch')
      }) as unknown as typeof fetch
      globalThis.fetch = fetchStub

      const result = await activities.readRepoFile({
        repoRoot,
        filePath,
        repository: 'proompteng/lab',
        commit,
      })

      expect(result.content).toBe(content)
      expect(result.metadata.repoCommit).toBe(commit)
      expect(result.metadata.metadata.source).toBe('git')
    } finally {
      globalThis.fetch = previousFetch
      await rm(repoRoot, { recursive: true, force: true })
    }
  })

  it('fetches from GitHub when local file is missing', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'bumba-'))
    const filePath = 'services/bumba/src/workflows/index.test.ts'
    const commit = 'deadbeef'
    const content = 'console.log("hello")'
    const encoded = Buffer.from(content, 'utf8').toString('base64')

    const previousToken = process.env.GITHUB_TOKEN
    const previousFetch = globalThis.fetch
    let requestedUrl: string | null = null

    process.env.GITHUB_TOKEN = 'token'
    globalThis.fetch = (async (input) => {
      requestedUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input instanceof Request
              ? input.url
              : null
      return new Response(
        JSON.stringify({
          type: 'file',
          encoding: 'base64',
          content: encoded,
          size: content.length,
          download_url: 'https://raw.githubusercontent.com/proompteng/lab/deadbeef/file.ts',
          url: 'https://api.github.com/repos/proompteng/lab/contents/file.ts',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch

    try {
      const result = await activities.readRepoFile({
        repoRoot,
        filePath,
        repository: 'proompteng/lab',
        commit,
      })

      expect(result.content).toBe(content)
      expect(result.metadata.repoCommit).toBe(commit)
      expect(result.metadata.metadata.source).toBe('github')
      expect(requestedUrl).not.toBeNull()
      expect(String(requestedUrl)).toContain(`/repos/proompteng/lab/contents/${filePath}`)
      expect(String(requestedUrl)).toContain(`ref=${commit}`)
    } finally {
      if (previousToken === undefined) {
        delete process.env.GITHUB_TOKEN
      } else {
        process.env.GITHUB_TOKEN = previousToken
      }
      globalThis.fetch = previousFetch
      await rm(repoRoot, { recursive: true, force: true })
    }
  })
})
