import { afterEach, describe, expect, it } from 'vitest'

import {
  CODEX_APP_SERVER_EFFORTS,
  extractProviderSecretEnvNames,
  matchesAnyPattern,
  normalizeLabelMap,
  providerUsesControllerAuthSecret,
  resolveProviderAdapterType,
  validateAuthSecretPolicy,
  validateImagePolicy,
  validateLabelPolicy,
  validateProviderModelEffortOverrides,
  validateProviderSecretEnvPolicy,
} from '~/server/agents-controller/policy'
import { AGY_CLI_EFFORTS } from '~/runner/spec'

afterEach(() => {
  delete process.env.AGENTS_CONTROLLER_LABELS_REQUIRED
  delete process.env.AGENTS_CONTROLLER_LABELS_ALLOWED
  delete process.env.AGENTS_CONTROLLER_LABELS_DENIED
  delete process.env.AGENTS_CONTROLLER_IMAGES_ALLOWED
  delete process.env.AGENTS_CONTROLLER_IMAGES_DENIED
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
    process.env.AGENTS_CONTROLLER_LABELS_REQUIRED = JSON.stringify(['team', 'service'])
    const required = validateLabelPolicy({ team: 'platform' })
    expect(required).toEqual({
      ok: false,
      reason: 'MissingRequiredLabels',
      message: 'missing required labels: service',
    })

    process.env.AGENTS_CONTROLLER_LABELS_REQUIRED = ''
    process.env.AGENTS_CONTROLLER_LABELS_DENIED = JSON.stringify(['internal/*'])
    const denied = validateLabelPolicy({ 'internal/secret': '1' })
    expect(denied).toEqual({
      ok: false,
      reason: 'LabelBlocked',
      message: 'labels blocked by controller policy: internal/secret',
    })

    process.env.AGENTS_CONTROLLER_LABELS_DENIED = ''
    process.env.AGENTS_CONTROLLER_LABELS_ALLOWED = JSON.stringify(['team', 'app.kubernetes.io/*'])
    const allowed = validateLabelPolicy({ team: 'platform', forbidden: 'x' })
    expect(allowed).toEqual({
      ok: false,
      reason: 'LabelNotAllowed',
      message: 'labels not allowed by controller policy: forbidden',
    })
  })

  it('validates image allow/deny policy with contextual messages', () => {
    process.env.AGENTS_CONTROLLER_IMAGES_DENIED = JSON.stringify(['registry.bad/*'])
    const blocked = validateImagePolicy([{ image: 'registry.bad/app:1', context: 'job runtime' }])
    expect(blocked).toEqual({
      ok: false,
      reason: 'ImageBlocked',
      message: 'image registry.bad/app:1 for job runtime is blocked by controller policy',
    })

    process.env.AGENTS_CONTROLLER_IMAGES_DENIED = ''
    process.env.AGENTS_CONTROLLER_IMAGES_ALLOWED = JSON.stringify(['registry.good/*'])
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

  it('scopes controller authSecret usage to Codex providers only', () => {
    expect(
      providerUsesControllerAuthSecret({
        spec: { binary: '/usr/local/bin/agent-runner', adapter: { type: 'codex-app-server' } },
      }),
    ).toBe(true)
    expect(providerUsesControllerAuthSecret({ spec: { binary: '/usr/local/bin/agent-runner' } })).toBe(true)
    expect(
      providerUsesControllerAuthSecret({
        spec: { binary: '/usr/local/bin/agent-runner', adapter: { type: 'agy-cli' } },
      }),
    ).toBe(false)
    expect(
      providerUsesControllerAuthSecret({
        spec: { binary: '/usr/local/bin/anypi-runner', adapter: { type: 'exec' } },
      }),
    ).toBe(false)
  })

  it('extracts and validates provider secretEnv secret names against Agent allowedSecrets', () => {
    expect(
      extractProviderSecretEnvNames({
        spec: {
          secretEnv: [
            { name: 'GOOGLE_APPLICATION_CREDENTIALS_JSON', secretName: 'google-adc-auth', key: 'credentials.json' },
            { name: 'EXTRA', secretName: 'google-adc-auth', key: 'other' },
          ],
        },
      }),
    ).toEqual(['google-adc-auth'])

    expect(validateProviderSecretEnvPolicy(['github-token'], ['google-adc-auth'])).toEqual({
      ok: false,
      reason: 'SecretNotAllowed',
      message: 'provider secretEnv references disallowed secrets: google-adc-auth',
    })
    expect(validateProviderSecretEnvPolicy(['github-token', 'google-adc-auth'], ['google-adc-auth'])).toEqual({
      ok: true,
    })
    expect(validateProviderSecretEnvPolicy([], ['google-adc-auth'])).toEqual({ ok: true })
  })

  it('resolves provider adapter types consistently', () => {
    expect(resolveProviderAdapterType({ spec: { adapter: { type: 'agy-cli' } } })).toBe('agy-cli')
    expect(resolveProviderAdapterType({ spec: { adapter: { type: 'codex-app-server' } } })).toBe('codex-app-server')
    expect(resolveProviderAdapterType({ spec: { adapter: { type: 'exec' } } })).toBe('exec')
    expect(resolveProviderAdapterType({ spec: { binary: '/usr/local/bin/agent-runner' } })).toBe('codex-app-server')
    expect(resolveProviderAdapterType({ spec: { binary: '/usr/local/bin/anypi-runner' } })).toBe('exec')
  })

  it('validates per-run model and effort overrides for agy-cli and codex-app-server', () => {
    const googleProvider = {
      metadata: { name: 'google' },
      spec: {
        binary: '/usr/local/bin/agent-runner',
        adapter: {
          type: 'agy-cli',
          agy: { model: 'gemini-4-neon', effort: 'high' },
        },
      },
    }
    const codexProvider = {
      metadata: { name: 'codex' },
      spec: {
        binary: '/usr/local/bin/agent-runner',
        adapter: {
          type: 'codex-app-server',
          codex: { model: 'gpt-6.2-sol', effort: 'max' },
        },
      },
    }

    expect(validateProviderModelEffortOverrides(googleProvider, {})).toEqual({
      ok: true,
      adapterType: 'agy-cli',
    })
    expect(
      validateProviderModelEffortOverrides(googleProvider, {
        model: 'models/gemini-2.5-pro:latest',
        effort: 'xhigh',
      }),
    ).toEqual({
      ok: true,
      adapterType: 'agy-cli',
      model: 'models/gemini-2.5-pro:latest',
      effort: 'xhigh',
    })
    for (const effort of AGY_CLI_EFFORTS) {
      expect(validateProviderModelEffortOverrides(googleProvider, { effort })).toEqual({
        ok: true,
        adapterType: 'agy-cli',
        effort,
      })
    }
    for (const effort of CODEX_APP_SERVER_EFFORTS) {
      expect(validateProviderModelEffortOverrides(codexProvider, { model: 'gpt-6.2-sol', effort })).toEqual({
        ok: true,
        adapterType: 'codex-app-server',
        model: 'gpt-6.2-sol',
        effort,
      })
    }

    expect(validateProviderModelEffortOverrides(googleProvider, { model: 'a'.repeat(128) })).toEqual({
      ok: true,
      adapterType: 'agy-cli',
      model: 'a'.repeat(128),
    })

    expect(
      validateProviderModelEffortOverrides(
        { metadata: { name: 'custom' }, spec: { binary: '/usr/local/bin/custom-runner', adapter: { type: 'exec' } } },
        { model: '--anything goes', effort: 'custom' },
      ),
    ).toEqual({ ok: true, adapterType: 'exec' })
  })

  it('rejects invalid, empty, whitespace, control-character, and flag-injection model/effort overrides', () => {
    const googleProvider = {
      metadata: { name: 'google' },
      spec: { adapter: { type: 'agy-cli', agy: { model: 'gemini-4-neon', effort: 'high' } } },
    }
    const codexProvider = {
      metadata: { name: 'codex' },
      spec: { adapter: { type: 'codex-app-server', codex: { model: 'gpt-6.2-sol', effort: 'max' } } },
    }

    for (const badModel of [
      '',
      '   ',
      ' gemini-4-neon',
      'gemini-4-neon ',
      'gemini 4 neon',
      'gemini-4-neon\n--mode=plan',
      'gemini-4-neon\x00',
      '-gemini',
      '--model=evil',
      '--dangerously-skip-permissions',
      'gemini;rm -rf /',
      '$(whoami)',
      'a'.repeat(129),
    ]) {
      const result = validateProviderModelEffortOverrides(googleProvider, { model: badModel })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('InvalidModelOverride')
      }
    }

    for (const badAgyEffort of ['', '   ', ' high ', 'HIGH', '--effort=low', 'none', 'minimal', 'ultra', 'turbo']) {
      const result = validateProviderModelEffortOverrides(googleProvider, { effort: badAgyEffort })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('InvalidEffortOverride')
      }
    }

    for (const badCodexEffort of ['', '   ', ' max ', 'MAX', '--effort=high', 'turbo']) {
      const result = validateProviderModelEffortOverrides(
        codexProvider,
        { effort: badCodexEffort },
        { context: 'workflow step implement' },
      )
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('InvalidEffortOverride')
        expect(result.message).toContain('workflow step implement:')
      }
    }
  })

  it('enforces optional provider allowedModels and allowedEfforts allowlists', () => {
    const restrictedGoogle = {
      metadata: { name: 'google' },
      spec: {
        adapter: {
          type: 'agy-cli',
          agy: {
            model: 'gemini-4-neon',
            effort: 'high',
            allowedModels: ['gemini-4-neon', 'gemini-2.5-pro'],
            allowedEfforts: ['medium', 'high'],
          },
        },
      },
    }

    expect(validateProviderModelEffortOverrides(restrictedGoogle, {})).toEqual({
      ok: true,
      adapterType: 'agy-cli',
    })
    expect(
      validateProviderModelEffortOverrides(restrictedGoogle, { model: 'gemini-2.5-pro', effort: 'medium' }),
    ).toEqual({
      ok: true,
      adapterType: 'agy-cli',
      model: 'gemini-2.5-pro',
      effort: 'medium',
    })
    expect(validateProviderModelEffortOverrides(restrictedGoogle, { model: 'gemini-2.0-flash' })).toEqual({
      ok: false,
      reason: 'ModelOverrideNotAllowed',
      message:
        'parameters.model "gemini-2.0-flash" is not allowed by AgentProvider google (allowed: gemini-4-neon, gemini-2.5-pro)',
    })
    expect(validateProviderModelEffortOverrides(restrictedGoogle, { effort: 'xhigh' })).toEqual({
      ok: false,
      reason: 'EffortOverrideNotAllowed',
      message: 'parameters.effort "xhigh" is not allowed by AgentProvider google (allowed: medium, high)',
    })

    const overridesDisabled = {
      metadata: { name: 'codex-locked' },
      spec: {
        adapter: {
          type: 'codex-app-server',
          codex: {
            model: 'gpt-6.2-sol',
            effort: 'max',
            allowedModels: [],
            allowedEfforts: [],
          },
        },
      },
    }
    expect(validateProviderModelEffortOverrides(overridesDisabled, {})).toEqual({
      ok: true,
      adapterType: 'codex-app-server',
    })
    expect(validateProviderModelEffortOverrides(overridesDisabled, { model: 'gpt-6.2-sol' })).toEqual({
      ok: false,
      reason: 'ModelOverrideNotAllowed',
      message:
        'parameters.model "gpt-6.2-sol" is not allowed by AgentProvider codex-locked (model overrides are disabled)',
    })
    expect(validateProviderModelEffortOverrides(overridesDisabled, { effort: 'high' })).toEqual({
      ok: false,
      reason: 'EffortOverrideNotAllowed',
      message: 'parameters.effort "high" is not allowed by AgentProvider codex-locked (effort overrides are disabled)',
    })

    const malformedProvider = {
      metadata: { name: 'google' },
      spec: {
        adapter: {
          type: 'agy-cli',
          agy: {
            allowedModels: 'gemini-4-neon',
          },
        },
      },
    }
    expect(validateProviderModelEffortOverrides(malformedProvider, {})).toEqual({
      ok: false,
      reason: 'InvalidProviderConfig',
      message: 'adapter.agy.allowedModels must be an array of non-empty strings',
    })

    // Allowlists cannot widen past syntax or adapter effort validation.
    const unsafeAllowlist = {
      metadata: { name: 'google' },
      spec: {
        adapter: {
          type: 'agy-cli',
          agy: {
            allowedModels: ['--flag'],
            allowedEfforts: ['turbo'],
          },
        },
      },
    }
    expect(validateProviderModelEffortOverrides(unsafeAllowlist, { model: '--flag' })).toMatchObject({
      ok: false,
      reason: 'InvalidModelOverride',
    })
    expect(validateProviderModelEffortOverrides(unsafeAllowlist, { effort: 'turbo' })).toMatchObject({
      ok: false,
      reason: 'InvalidEffortOverride',
    })
  })
})
