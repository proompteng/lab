// @vitest-environment jsdom
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ControlPlaneStreamEvent } from '@/components/agents-control-plane-stream'
import { useControlPlaneStream } from '@/components/agents-control-plane-stream'

class MockEventSource {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2
  static instances: MockEventSource[] = []

  readyState = MockEventSource.OPEN
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    MockEventSource.instances.push(this)
  }

  close() {
    this.readyState = MockEventSource.CLOSED
  }

  emitMessage(data: string) {
    this.onmessage?.({ data } as MessageEvent)
  }
}

const makeResourceEvent = (): ControlPlaneStreamEvent => ({
  type: 'resource',
  kind: 'Agent',
  namespace: 'agents',
  action: null,
  name: null,
  resource: { apiVersion: null, kind: null, metadata: {}, spec: {}, status: {} },
})

describe('useControlPlaneStream', () => {
  const originalEventSource = globalThis.EventSource

  beforeEach(() => {
    MockEventSource.instances = []
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource
  })

  afterEach(() => {
    globalThis.EventSource = originalEventSource
  })

  it('avoids rerenders when emitState is false', () => {
    const events: ControlPlaneStreamEvent[] = []
    let renderCount = 0

    const Test = () => {
      useControlPlaneStream(
        'agents',
        {
          onEvent: (event) => {
            events.push(event)
          },
        },
        { emitState: false },
      )
      renderCount += 1
      return null
    }

    render(<Test />)

    const source = MockEventSource.instances[0]
    if (!source) {
      throw new Error('Expected EventSource instance to be created')
    }

    act(() => {
      source.emitMessage(JSON.stringify(makeResourceEvent()))
    })

    expect(events).toHaveLength(1)
    expect(renderCount).toBe(1)
  })
})
