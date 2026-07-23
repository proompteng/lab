import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const workflow = readFileSync('.github/workflows/bayn-release.yml', 'utf8')

describe('Bayn release workflow', () => {
  test('automatic releases explicitly preserve terminal qualification evidence', () => {
    expect(workflow).toContain('--qualification-intent preserve')
    expect(workflow).toContain('.qualificationIntent == "preserve"')
  })
})
