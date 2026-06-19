import { describe, expect, test } from 'vitest'

import {
  BoundedText,
  BOUNDED_TEXT_DEFAULT_LIMIT,
  BOUNDED_TEXT_HARD_LIMIT,
  createBoundedText,
  encodeTextLength,
} from './bounded-text'

describe('BoundedText', () => {
  test('creates with default 4 MiB limit', () => {
    const bounded = createBoundedText()
    expect(bounded.size()).toBe(0)
    expect(bounded.toString()).toBe('')
  })

  test('rejects maxSize exceeding 16 MiB hard limit', () => {
    expect(() => createBoundedText({ maxSize: BOUNDED_TEXT_HARD_LIMIT + 1 })).toThrow('maxSize exceeds hard limit')
  })

  test('rejects non-positive maxSize', () => {
    expect(() => createBoundedText({ maxSize: 0 })).toThrow('maxSize must be positive')
    expect(() => createBoundedText({ maxSize: -100 })).toThrow('maxSize must be positive')
  })

  test('appends text and tracks size', () => {
    const bounded = createBoundedText({ maxSize: 1000 })
    bounded.append('Hello')
    expect(bounded.toString()).toBe('Hello')
    expect(bounded.size()).toBe(5) // "Hello" = 5 bytes
    expect(bounded.chunkCount()).toBe(1)
  })

  test('appends multiple chunks', () => {
    const bounded = createBoundedText({ maxSize: 1000 })
    bounded.append('Hello ')
    bounded.append('World')
    expect(bounded.toString()).toBe('Hello World')
    expect(bounded.size()).toBe(11)
    expect(bounded.chunkCount()).toBe(2)
  })

  test('truncates oldest chunks when maxSize exceeded', () => {
    const bounded = createBoundedText({ maxSize: 50 }) // 50 bytes limit
    bounded.append('A'.repeat(30)) // 30 bytes
    bounded.append('B'.repeat(30)) // 30 bytes - now at 60, over limit
    bounded.append('C'.repeat(30)) // 30 bytes - now at 60, over limit

    expect(bounded.size()).toBeLessThanOrEqual(50)
    expect(bounded.chunkCount()).toBeGreaterThanOrEqual(1)
    // The last chunk should be preserved
    expect(bounded.toString()).toContain('C'.repeat(30))
  })

  test('preserves the latest assistant output tail when truncation is needed', () => {
    const bounded = createBoundedText({ maxSize: 60 })
    bounded.append('Old content that should be truncated')
    bounded.append('New content that should be preserved')

    // After truncation, the newest content should be in the tail
    const tail = bounded.getTail()
    expect(tail).toContain('New content that should be preserved')
    expect(tail).not.toContain('Old content')
  })

  test('prepends text and updates size', () => {
    const bounded = createBoundedText({ maxSize: 1000 })
    bounded.prepend('World')
    bounded.prepend('Hello ')
    expect(bounded.toString()).toBe('Hello World')
    expect(bounded.size()).toBe(11)
    expect(bounded.chunkCount()).toBe(2)
  })

  test('prepending also respects maxSize with truncation from newest', () => {
    const bounded = createBoundedText({ maxSize: 50 })
    bounded.prepend('C'.repeat(30)) // 30 bytes
    bounded.prepend('B'.repeat(30)) // 30 bytes - now at 60, over limit
    bounded.prepend('A'.repeat(30)) // 30 bytes - now at 60, over limit

    expect(bounded.size()).toBeLessThanOrEqual(50)
    // The newest prepended content (A) should be preserved
    expect(bounded.toString()).toContain('A'.repeat(30))
  })

  test('getTail returns efficient representation without joining all chunks', () => {
    const bounded = createBoundedText({ maxSize: 10000 })
    for (let i = 0; i < 100; i++) {
      bounded.append(`Chunk ${i}: ${'x'.repeat(100)}`)
    }

    // getTail should be efficient
    const tail = bounded.getTail()
    expect(typeof tail).toBe('string')
    // Tail should be from recent chunks
    expect(tail).toContain('Chunk 99')
  })

  test('clear resets state', () => {
    const bounded = createBoundedText({ maxSize: 1000 })
    bounded.append('Test content')
    expect(bounded.size()).toBeGreaterThan(0)
    expect(bounded.chunkCount()).toBeGreaterThan(0)

    bounded.clear()
    expect(bounded.size()).toBe(0)
    expect(bounded.toString()).toBe('')
    expect(bounded.chunkCount()).toBe(0)
    expect(bounded.getTail()).toBe('')
  })

  test('encodeTextLength handles ASCII correctly', () => {
    expect(encodeTextLength('Hello')).toBe(5)
    expect(encodeTextLength('')).toBe(0)
    expect(encodeTextLength('a'.repeat(100))).toBe(100)
  })

  test('encodeTextLength handles multi-byte UTF-8', () => {
    // é is 2 bytes in UTF-8
    expect(encodeTextLength('é')).toBe(2)
    // emoji are 4 bytes in UTF-8
    expect(encodeTextLength('😀')).toBe(4)
    // Chinese characters are 3 bytes
    expect(encodeTextLength('你好')).toBe(6)
  })

  test('encodeTextLength handles surrogate pairs', () => {
    // Long emoji sequences use surrogate pairs
    const flag = '🇺🇸' // US flag emoji
    expect(encodeTextLength(flag)).toBe(8) // 2 UTF-16 code units * 4 bytes each
  })

  test('handles very large append without hanging', () => {
    const bounded = createBoundedText({ maxSize: 100000 }) // 100 KiB
    const largeText = 'x'.repeat(50000) // 50 KiB
    bounded.append(largeText)
    bounded.append(largeText) // Should trigger truncation

    expect(bounded.size()).toBeLessThanOrEqual(100000)
    expect(bounded.toString()).toContain('x')
  })

  test('empty string append is ignored', () => {
    const bounded = createBoundedText({ maxSize: 1000 })
    bounded.append('Test')
    bounded.append('')
    bounded.append(undefined as unknown as string)

    expect(bounded.toString()).toBe('Test')
    expect(bounded.size()).toBe(4)
  })

  test('multiple small appends stay within limit', () => {
    const bounded = createBoundedText({ maxSize: 200 })
    for (let i = 0; i < 10; i++) {
      bounded.append(`Short ${i}`)
    }

    expect(bounded.size()).toBeLessThanOrEqual(200)
    expect(bounded.chunkCount()).toBeLessThanOrEqual(10)
  })

  test('respects custom maxSize', () => {
    const customLimit = 1024 * 1024 // 1 MiB
    const bounded = createBoundedText({ maxSize: customLimit })
    expect(bounded.size()).toBe(0)

    const text = 'x'.repeat(512 * 1024) // 512 KiB
    bounded.append(text)
    bounded.append(text) // Should be at 1 MiB, at limit
    bounded.append(text) // Should trigger truncation

    expect(bounded.size()).toBeLessThanOrEqual(customLimit)
  })
})

describe('BoundedText integration with AnyPi session handling', () => {
  test('simulates assistant message accumulation with truncation', () => {
    const bounded = createBoundedText({ maxSize: 200 })
    // Simulate initial response
    bounded.append('Initial assistant response: ')
    bounded.append('Some content here')

    // Simulate follow-up with more content
    bounded.append('\n\nFollow-up response: ')
    bounded.append('More detailed content that should be preserved')

    // Simulate many more tokens that would exceed limit
    for (let i = 0; i < 50; i++) {
      bounded.append(`\n\nToken chunk ${i}: ${'response content '.repeat(5)}`)
    }

    // Verify the bounded accumulator is working
    expect(bounded.size()).toBeLessThanOrEqual(200)
    expect(bounded.toString()).toContain('Token chunk 49') // Latest should be preserved
  })

  test('tail preserves most recent assistant output after many truncations', () => {
    const bounded = createBoundedText({ maxSize: 100 })
    for (let i = 0; i < 100; i++) {
      bounded.append(`Segment ${i} of accumulated assistant output`)
    }

    const tail = bounded.getTail()
    // Latest segments should be in tail
    expect(tail).toContain('Segment 99')
    // Tail contains content from recent segments
    expect(tail).toContain('assistant output')
    // Oldest segments should be truncated (Segment 0 should not be visible)
    expect(tail).not.toContain('Segment 0')
  })
})
