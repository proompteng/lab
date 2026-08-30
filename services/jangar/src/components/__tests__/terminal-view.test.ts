import { describe, expect, it, vi } from 'vitest'

import { __private } from '../terminal-view'

describe('terminal-view renderer safety', () => {
  it('defaults renderer to dom when query is absent', () => {
    expect(__private.resolveRequestedRenderer('')).toBe('dom')
    expect(__private.resolveEffectiveRenderer('')).toBe('dom')
  })

  it('falls back to dom when experimental renderer is requested and feature flag is disabled', () => {
    expect(__private.resolveRequestedRenderer('?renderer=canvas')).toBe('canvas')
    expect(__private.resolveRequestedRenderer('?renderer=webgl')).toBe('webgl')
    expect(__private.resolveEffectiveRenderer('?renderer=canvas', false)).toBe('dom')
    expect(__private.resolveEffectiveRenderer('?renderer=webgl', false)).toBe('dom')
  })

  it('allows experimental renderers only when explicitly enabled', () => {
    expect(__private.resolveEffectiveRenderer('?renderer=canvas', true)).toBe('canvas')
    expect(__private.resolveEffectiveRenderer('?renderer=webgl', true)).toBe('webgl')
  })
})

describe('terminal-view dispose safety', () => {
  it('swallows terminal dispose errors and logs warning', () => {
    const warn = vi.fn()
    const terminal = {
      dispose: vi.fn(() => {
        throw new Error('dispose failed')
      }),
    }

    expect(() =>
      __private.safeTerminalDispose(terminal as unknown as import('@xterm/xterm').Terminal, { warn }),
    ).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
