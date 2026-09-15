import { describe, expect, it } from 'vitest'

import {
  createAgentsControllerLifecycleActor,
  getAgentsControllerLifecycleStatus,
  markAgentsControllerStarted,
  markAgentsControllerStartFailed,
  requestAgentsControllerStart,
  requestAgentsControllerStop,
} from '~/server/agents-controller/lifecycle-machine'

describe('agents controller lifecycle machine', () => {
  it('starts in idle', () => {
    const actor = createAgentsControllerLifecycleActor()
    expect(getAgentsControllerLifecycleStatus(actor)).toBe('idle')
  })

  it('accepts one start request and rejects duplicates while starting', () => {
    const actor = createAgentsControllerLifecycleActor()
    expect(requestAgentsControllerStart(actor)).toBe(true)
    expect(getAgentsControllerLifecycleStatus(actor)).toBe('starting')
    expect(requestAgentsControllerStart(actor)).toBe(false)
    expect(getAgentsControllerLifecycleStatus(actor)).toBe('starting')
  })

  it('moves to running on successful start', () => {
    const actor = createAgentsControllerLifecycleActor()
    requestAgentsControllerStart(actor)
    markAgentsControllerStarted(actor)
    expect(getAgentsControllerLifecycleStatus(actor)).toBe('running')
  })

  it('returns to idle when startup fails', () => {
    const actor = createAgentsControllerLifecycleActor()
    requestAgentsControllerStart(actor)
    markAgentsControllerStartFailed(actor)
    expect(getAgentsControllerLifecycleStatus(actor)).toBe('idle')
  })

  it('transitions to idle on stop from running', () => {
    const actor = createAgentsControllerLifecycleActor()
    requestAgentsControllerStart(actor)
    markAgentsControllerStarted(actor)
    requestAgentsControllerStop(actor)
    expect(getAgentsControllerLifecycleStatus(actor)).toBe('idle')
  })

  it('ignores started/failed markers when actor is not in starting state', () => {
    const actor = createAgentsControllerLifecycleActor()
    markAgentsControllerStarted(actor)
    expect(getAgentsControllerLifecycleStatus(actor)).toBe('idle')

    requestAgentsControllerStart(actor)
    markAgentsControllerStarted(actor)
    expect(getAgentsControllerLifecycleStatus(actor)).toBe('running')

    markAgentsControllerStartFailed(actor)
    expect(getAgentsControllerLifecycleStatus(actor)).toBe('running')
  })
})
