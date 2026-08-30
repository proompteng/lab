import { describe, expect, test } from 'bun:test'

import { CodeWriteEchoTracker } from './code-write-echo'

describe('Code write echo tracking', () => {
  test('recognizes overlapping saves and retires an older echo once a newer write is authoritative', () => {
    const tracker = new CodeWriteEchoTracker()

    tracker.begin('/workspace/main.rs', 'first')
    tracker.begin('/workspace/main.rs', 'second')
    tracker.remember('/workspace/main.rs', 'first')
    tracker.finish('/workspace/main.rs', 'first')

    expect(tracker.matches('/workspace/main.rs', 'first')).toBe(true)
    expect(tracker.matches('/workspace/main.rs', 'second')).toBe(true)

    tracker.remember('/workspace/main.rs', 'second')
    tracker.finish('/workspace/main.rs', 'second')

    expect(tracker.matches('/workspace/main.rs', 'first')).toBe(false)
    expect(tracker.matches('/workspace/main.rs', 'second')).toBe(true)
  })

  test('counts duplicate pending writes and clears all state for a moved or closed path', () => {
    const tracker = new CodeWriteEchoTracker()

    tracker.begin('/workspace/main.rs', 'same')
    tracker.begin('/workspace/main.rs', 'same')
    tracker.finish('/workspace/main.rs', 'same')
    expect(tracker.matches('/workspace/main.rs', 'same')).toBe(true)

    tracker.clearPath('/workspace/main.rs')
    expect(tracker.matches('/workspace/main.rs', 'same')).toBe(false)
  })
})
