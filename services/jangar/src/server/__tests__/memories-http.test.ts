import { describe, expect, it } from 'vitest'

import {
  MAX_CONTENT_CHARS,
  MAX_SUMMARY_CHARS,
  parsePersistMemoryInput,
  parseRetrieveMemoryInput,
} from '../memories-http'

describe('memories http input parsing', () => {
  it('parses persist payloads and normalizes fields', () => {
    const parsed = parsePersistMemoryInput({
      namespace: '  project-x  ',
      content: '  hello world  ',
      summary: '  short  ',
      tags: [' tag-1 ', '', 123],
    })

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.value.namespace).toBe('project-x')
    expect(parsed.value.content).toBe('hello world')
    expect(parsed.value.summary).toBe('short')
    expect(parsed.value.tags).toEqual(['tag-1'])
  })

  it('rejects missing content for persist payloads', () => {
    const parsed = parsePersistMemoryInput({ namespace: 'default' })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.message).toBe('Content is required.')
  })

  it('rejects oversized persist payloads', () => {
    const parsed = parsePersistMemoryInput({ content: 'x'.repeat(MAX_CONTENT_CHARS + 1) })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.message).toContain(String(MAX_CONTENT_CHARS))

    const summaryParsed = parsePersistMemoryInput({
      content: 'hello',
      summary: 'x'.repeat(MAX_SUMMARY_CHARS + 1),
    })
    expect(summaryParsed.ok).toBe(false)
    if (summaryParsed.ok) return
    expect(summaryParsed.message).toContain(String(MAX_SUMMARY_CHARS))
  })

  it('parses retrieve payloads and clamps limits', () => {
    const parsed = parseRetrieveMemoryInput({
      namespace: '  demo ',
      query: '  find me  ',
      limit: '75',
    })

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.value.namespace).toBe('demo')
    expect(parsed.value.query).toBe('find me')
    expect(parsed.value.limit).toBe(50)
  })

  it('treats namespace as an optional filter for retrieve payloads', () => {
    const parsed = parseRetrieveMemoryInput({ query: 'find me' })

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.value.namespace).toBeUndefined()
  })

  it('rejects missing query for retrieve payloads', () => {
    const parsed = parseRetrieveMemoryInput({ namespace: 'demo' })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.message).toBe('Query is required.')
  })
})
