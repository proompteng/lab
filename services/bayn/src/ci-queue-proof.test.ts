import { expect, test } from 'bun:test'

test('temporary merge-queue proof detects a broken assertion excluded by PR selection', () => {
  expect('candidate').toBe('baseline')
})
