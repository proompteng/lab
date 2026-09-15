import { describe, expect, test } from 'bun:test'

import { finderItemFormSchema } from './finder-item'

describe('Finder item form schema', () => {
  test('preserves valid leading and trailing whitespace', () => {
    expect(finderItemFormSchema.parse({ name: ' report ' })).toEqual({ name: ' report ' })
  })

  test.each(['', '   ', '.', '..', 'folder/name', 'folder\nname', `folder\0name`])(
    'rejects the invalid name %p',
    (name) => {
      expect(finderItemFormSchema.safeParse({ name }).success).toBe(false)
    },
  )

  test('enforces the filesystem byte limit without changing the name', () => {
    const name = '🐉'.repeat(64)
    expect(finderItemFormSchema.safeParse({ name }).success).toBe(false)
  })
})
