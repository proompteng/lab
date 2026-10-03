import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { formatCommand } from './process-runner'

describe('command display argument boundaries', () => {
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
