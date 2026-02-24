import { afterEach, describe, expect, it } from 'vitest'

import {
  buildArtifactsLimitMessage,
  limitAgentRunStatusArtifacts,
  resolveAgentRunArtifactsLimitConfig,
} from '~/server/agents-controller/agentrun-artifacts'

afterEach(() => {
  delete process.env.JANGAR_AGENTRUN_ARTIFACTS_MAX
  delete process.env.JANGAR_AGENTRUN_ARTIFACTS_STRICT
})

describe('agentrun artifacts limits module', () => {
  it('uses env parsing fallbacks and accepts override values', () => {
    process.env.JANGAR_AGENTRUN_ARTIFACTS_MAX = '7'
    process.env.JANGAR_AGENTRUN_ARTIFACTS_STRICT = 'yes'

    const fromEnv = resolveAgentRunArtifactsLimitConfig()
    expect(fromEnv).toEqual({
      maxEntries: 7,
      strict: true,
      urlMaxLength: 2048,
    })

    process.env.JANGAR_AGENTRUN_ARTIFACTS_MAX = 'invalid'
    process.env.JANGAR_AGENTRUN_ARTIFACTS_STRICT = 'maybe'

    const fallback = resolveAgentRunArtifactsLimitConfig()
    expect(fallback).toEqual({
      maxEntries: 50,
      strict: false,
      urlMaxLength: 2048,
    })

    const overridden = resolveAgentRunArtifactsLimitConfig({ maxEntries: 3, strict: false, urlMaxLength: 128 })
    expect(overridden).toEqual({
      maxEntries: 3,
      strict: false,
      urlMaxLength: 128,
    })
  })

  it('caps maxEntries to the hard limit of 50', () => {
    process.env.JANGAR_AGENTRUN_ARTIFACTS_MAX = '100'
    const config = resolveAgentRunArtifactsLimitConfig()
    expect(config.maxEntries).toBe(50)
  })

  it('removes inline and oversized urls while preserving valid artifacts', () => {
    const result = limitAgentRunStatusArtifacts(
      [
        { name: 'ok', url: 'https://example.com/ok' },
        { name: 'inline', url: 'data:text/plain;base64,Zm9v' },
        { name: 'long', url: 'https://example.com/this-url-is-too-long' },
      ],
      { maxEntries: 50, strict: false, urlMaxLength: 24 },
    )

    expect(result.strictViolation).toBe(false)
    expect(result.strippedUrlCount).toBe(2)
    expect(result.artifacts).toEqual([
      { name: 'ok', url: 'https://example.com/ok' },
      { name: 'inline' },
      { name: 'long' },
    ])
    expect(result.reasons).toEqual(expect.arrayContaining(['InlineUrlDisallowed', 'UrlTooLong']))
  })

  it('marks strictViolation when count exceeds maxEntries in strict mode', () => {
    const result = limitAgentRunStatusArtifacts([{ name: 'a1' }, { name: 'a2' }, { name: 'a3' }], {
      maxEntries: 2,
      strict: true,
      urlMaxLength: 2048,
    })

    expect(result.strictViolation).toBe(true)
    expect(result.trimmedCount).toBe(1)
    expect(result.artifacts.map((item) => item.name)).toEqual(['a2', 'a3'])
    expect(result.reasons).toContain('TooManyArtifacts')
    expect(buildArtifactsLimitMessage(result)).toContain('dropped 1 oldest artifact(s)')
  })

  it('drops invalid records and names, preserves trimmed path/key, and flags strict URL violations', () => {
    const result = limitAgentRunStatusArtifacts(
      [
        null,
        1,
        { name: '   ' },
        {
          name: ' artifact-1 ',
          path: ' /tmp/out.txt ',
          key: ' result-key ',
          url: 'data:text/plain;base64,Zm9v',
        },
        {
          name: 'artifact-2',
          path: ' /tmp/ok.txt ',
          key: ' ok-key ',
          url: 'https://example.com/ok',
        },
      ],
      { maxEntries: 10, strict: true, urlMaxLength: 2048 },
    )

    expect(result.strictViolation).toBe(true)
    expect(result.droppedCount).toBe(1)
    expect(result.strippedUrlCount).toBe(1)
    expect(result.reasons).toEqual(expect.arrayContaining(['MissingName', 'InlineUrlDisallowed']))
    expect(result.artifacts).toEqual([
      { name: 'artifact-1', path: '/tmp/out.txt', key: 'result-key' },
      { name: 'artifact-2', path: '/tmp/ok.txt', key: 'ok-key', url: 'https://example.com/ok' },
    ])
  })

  it('supports a zero maxEntries limit and keeps empty result messaging stable', () => {
    const zeroLimited = limitAgentRunStatusArtifacts([{ name: 'a1' }, { name: 'a2' }], {
      maxEntries: 0,
      strict: false,
      urlMaxLength: 2048,
    })

    expect(zeroLimited.trimmedCount).toBe(2)
    expect(zeroLimited.artifacts).toEqual([])
    expect(zeroLimited.reasons).toContain('TooManyArtifacts')

    const empty = limitAgentRunStatusArtifacts({ not: 'an array' }, { maxEntries: 5, strict: false, urlMaxLength: 10 })
    expect(empty.artifacts).toEqual([])
    expect(empty.reasons).toEqual([])
    expect(buildArtifactsLimitMessage(empty)).toBe('artifacts within limits')
  })
})
