import { describe, expect, it } from 'bun:test'

import { VersioningBehavior, WorkflowIdReusePolicy } from '../src/worker/index'

describe('worker public API', () => {
  it('exports workflow start policy enums used by worker consumers', () => {
    expect(VersioningBehavior.PINNED).toBeDefined()
    expect(WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY).toBeDefined()
  })
})
