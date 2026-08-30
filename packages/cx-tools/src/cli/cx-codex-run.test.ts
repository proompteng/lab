import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildCommandArgs, parseCodexRunArgs, parsePrompt } from './cx-codex-run'

describe('cx-codex-run parser', () => {
  it('builds default codex exec arguments', () => {
    const args = buildCommandArgs(parseCodexRunArgs(['--binary', 'codex-local', 'say hello']))

    expect(args).toEqual(['exec', '--json'])
  })

  it('does not swallow positional prompt as unknown flag value', () => {
    const args = parseCodexRunArgs(['--dangerous-flag', 'please run this'])

    expect(args.passthrough).toEqual(['--dangerous-flag'])
    expect(args.prompt).toBe('please run this')
  })
})

describe('cx-codex-run prompt parsing', () => {
  it('loads prompt from file and rejects mixed inline prompt', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'cx-codex-run-'))
    const filePath = join(temp, 'prompt.txt')
    writeFileSync(filePath, 'prompt from file\n')

    const parsed = parseCodexRunArgs(['--prompt-file', filePath, '--prompt', 'inline'])

    await expect(parsePrompt(parsed)).rejects.toMatchObject({
      message: 'Use either --prompt or --prompt-file, not both.',
    })

    const parsedFileOnly = parseCodexRunArgs(['--prompt-file', filePath])

    await expect(parsePrompt(parsedFileOnly)).resolves.toBe('prompt from file')

    rmSync(temp, { recursive: true, force: true })
  })
})
