import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { afterEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('./apply_patch.py', import.meta.url))

const tempRoots: string[] = []

const tempWorkspace = () => {
  const root = mkdtempSync(join(tmpdir(), 'agents-apply-patch-'))
  tempRoots.push(root)
  return root
}

const runPatch = (cwd: string, patch: string) =>
  spawnSync('python3', [script], {
    cwd,
    input: patch,
    encoding: 'utf8',
  })

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

describe('apply_patch script', () => {
  it('applies Codex add, update, and delete sections', () => {
    const cwd = tempWorkspace()

    const add = runPatch(
      cwd,
      ['*** Begin Patch', '*** Add File: src/example.txt', '+old', '*** End Patch', ''].join('\n'),
    )
    expect(add.status).toBe(0)
    expect(readFileSync(join(cwd, 'src/example.txt'), 'utf8')).toBe('old\n')

    const update = runPatch(
      cwd,
      ['*** Begin Patch', '*** Update File: src/example.txt', '@@', '-old', '+new', '*** End Patch', ''].join('\n'),
    )
    expect(update.status).toBe(0)
    expect(readFileSync(join(cwd, 'src/example.txt'), 'utf8')).toBe('new\n')

    const remove = runPatch(
      cwd,
      ['*** Begin Patch', '*** Delete File: src/example.txt', '*** End Patch', ''].join('\n'),
    )
    expect(remove.status).toBe(0)
    expect(existsSync(join(cwd, 'src/example.txt'))).toBe(false)
  })

  it('keeps patch paths under the working directory', () => {
    const cwd = tempWorkspace()
    writeFileSync(join(cwd, 'safe.txt'), 'safe\n')

    const result = runPatch(
      cwd,
      ['*** Begin Patch', '*** Add File: ../escape.txt', '+bad', '*** End Patch', ''].join('\n'),
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('patch path must stay under working directory')
    expect(existsSync(join(cwd, '../escape.txt'))).toBe(false)
  })

  it('accepts the Codex end-of-file marker in update hunks', () => {
    const cwd = tempWorkspace()
    writeFileSync(join(cwd, 'example.txt'), 'old\n')

    const result = runPatch(
      cwd,
      [
        '*** Begin Patch',
        '*** Update File: example.txt',
        '@@',
        '-old',
        '+new',
        '*** End of File',
        '*** End Patch',
        '',
      ].join('\n'),
    )

    expect(result.status).toBe(0)
    expect(readFileSync(join(cwd, 'example.txt'), 'utf8')).toBe('new\n')
  })
})
