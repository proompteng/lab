import { describe, expect, test } from 'bun:test'

import { decodeGreetingRequest, durableStepKinds, greetingMessage } from './domain'

describe('Restate example domain', () => {
  test('trims and validates greeting requests', () => {
    expect(decodeGreetingRequest({ name: ' GitOps ' })).toEqual({ name: 'GitOps' })
    expect(() => decodeGreetingRequest({ name: '   ' })).toThrow()
    expect(() => decodeGreetingRequest({})).toThrow()
  })

  test('keeps the smoke-test response contract stable', () => {
    expect(greetingMessage('GitOps')).toBe('Hello, GitOps from Restate')
    expect(durableStepKinds).toEqual(['notification', 'reminder'])
  })
})
