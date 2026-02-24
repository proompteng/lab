import { afterEach, describe, expect, it } from 'vitest'

import {
  matchesAnyPattern,
  normalizeLabelMap,
  validateAuthSecretPolicy,
  validateImagePolicy,
  validateLabelPolicy,
} from '~/server/agents-controller/policy'

afterEach(() => {
  delete process.env.JANGAR_AGENTS_CONTROLLER_LABELS_REQUIRED
  delete process.env.JANGAR_AGENTS_CONTROLLER_LABELS_ALLOWED
  delete process.env.JANGAR_AGENTS_CONTROLLER_LABELS_DENIED
  delete process.env.JANGAR_AGENTS_CONTROLLER_IMAGES_ALLOWED
  delete process.env.JANGAR_AGENTS_CONTROLLER_IMAGES_DENIED
})

describe('agents controller policy module', () => {
  it('matches wildcard patterns', () => {
    expect(matchesAnyPattern('registry.example.com/app:1', ['registry.example.com/*'])).toBe(true)
    expect(matchesAnyPattern('registry.example.com/app:1', ['ghcr.io/*'])).toBe(false)
    expect(matchesAnyPattern('anything', ['*'])).toBe(true)
  })

  it('normalizes label maps by trimming and dropping invalid values', () => {
    const normalized = normalizeLabelMap({
      team: ' platform ',
      empty: '   ',
      count: 1,
    })
    expect(normalized).toEqual({
      team: 'platform',
    })
  })

  it('validates required, denied, and allowed label policies', () => {
    process.env.JANGAR_AGENTS_CONTROLLER_LABELS_REQUIRED = JSON.stringify(['team', 'service'])
    const required = validateLabelPolicy({ team: 'platform' })
    expect(required).toEqual({
      ok: false,
      reason: 'MissingRequiredLabels',
      message: 'missing required labels: service',
    })

    process.env.JANGAR_AGENTS_CONTROLLER_LABELS_REQUIRED = ''
    process.env.JANGAR_AGENTS_CONTROLLER_LABELS_DENIED = JSON.stringify(['internal/*'])
    const denied = validateLabelPolicy({ 'internal/secret': '1' })
    expect(denied).toEqual({
      ok: false,
      reason: 'LabelBlocked',
      message: 'labels blocked by controller policy: internal/secret',
    })

    process.env.JANGAR_AGENTS_CONTROLLER_LABELS_DENIED = ''
    process.env.JANGAR_AGENTS_CONTROLLER_LABELS_ALLOWED = JSON.stringify(['team', 'app.kubernetes.io/*'])
    const allowed = validateLabelPolicy({ team: 'platform', forbidden: 'x' })
    expect(allowed).toEqual({
      ok: false,
      reason: 'LabelNotAllowed',
      message: 'labels not allowed by controller policy: forbidden',
    })
  })

  it('validates image allow/deny policy with contextual messages', () => {
    process.env.JANGAR_AGENTS_CONTROLLER_IMAGES_DENIED = JSON.stringify(['registry.bad/*'])
    const blocked = validateImagePolicy([{ image: 'registry.bad/app:1', context: 'job runtime' }])
    expect(blocked).toEqual({
      ok: false,
      reason: 'ImageBlocked',
      message: 'image registry.bad/app:1 for job runtime is blocked by controller policy',
    })

    process.env.JANGAR_AGENTS_CONTROLLER_IMAGES_DENIED = ''
    process.env.JANGAR_AGENTS_CONTROLLER_IMAGES_ALLOWED = JSON.stringify(['registry.good/*'])
    const notAllowed = validateImagePolicy([{ image: 'registry.other/app:2' }])
    expect(notAllowed).toEqual({
      ok: false,
      reason: 'ImageNotAllowed',
      message: 'image registry.other/app:2 is not allowed by controller policy',
    })

    const ok = validateImagePolicy([])
    expect(ok).toEqual({ ok: true })
  })

  it('validates auth secret allowlist policy', () => {
    expect(validateAuthSecretPolicy([], null)).toEqual({ ok: true })
    expect(validateAuthSecretPolicy(['allowed'], { name: 'denied' })).toEqual({
      ok: false,
      reason: 'SecretNotAllowed',
      message: 'auth secret denied is not allowlisted by the Agent',
    })
    expect(validateAuthSecretPolicy(['allowed'], { name: 'allowed' })).toEqual({ ok: true })
  })
})
