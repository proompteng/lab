import { describe, expect, test } from 'bun:test'
import { createAgentFormSchema } from './tengri-agent'

describe('Tengri create-agent form', () => {
  test('trims a valid display name', () => {
    expect(createAgentFormSchema.parse({ displayName: '  Tengri  ' })).toEqual({ displayName: 'Tengri' })
  })

  test('rejects empty and oversized display names', () => {
    expect(createAgentFormSchema.safeParse({ displayName: '   ' }).success).toBe(false)
    expect(createAgentFormSchema.safeParse({ displayName: 'a'.repeat(65) }).success).toBe(false)
  })
})
