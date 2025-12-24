import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { activities } from './index'

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
