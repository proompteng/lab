import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_AGENTS_BASE_URL,
  DEFAULT_K8S_AGENTS_BASE_URL,
  DEFAULT_K8S_SAME_NAMESPACE_AGENTS_BASE_URL,
  parseCliFlags,
  parseCommaList,
  parseJson,
  resolveAgentsBaseUrl,
} from '../cli'

describe('parseCliFlags', () => {
  it('parses flags with equals and space separators', () => {
    const result = parseCliFlags(['--alpha=one', '--beta', 'two', '--flag'])
    expect(result.alpha).toBe('one')
    expect(result.beta).toBe('two')
    expect(result.flag).toBe(true)
  })

  it('throws if a flag lacks a name', () => {
    expect(() => parseCliFlags(['--', 'value'])).toThrow()
  })
})

describe('parseCommaList', () => {
  it('splits and trims comma-separated values', () => {
    expect(parseCommaList('a, b, ,c')).toEqual(['a', 'b', 'c'])
  })
})

describe('parseJson', () => {
  it('returns parsed object for valid JSON', () => {
    expect(parseJson('{"foo":123}')).toEqual({ foo: 123 })
  })

  it('throws for invalid JSON', () => {
    expect(() => parseJson('{bad}')).toThrow()
  })
})

describe('resolveAgentsBaseUrl', () => {
  it('uses explicit override env vars and trims trailing slash', () => {
    expect(
      resolveAgentsBaseUrl({
        env: { MEMORIES_AGENTS_URL: 'http://custom.example/' },
        kubernetesNamespace: null,
      }),
    ).toBe('http://custom.example')
  })

  it('uses in-namespace service when running inside agents namespace', () => {
    expect(
      resolveAgentsBaseUrl({
        env: {},
        kubernetesNamespace: 'agents',
      }),
    ).toBe(DEFAULT_K8S_SAME_NAMESPACE_AGENTS_BASE_URL)
  })

  it('uses cross-namespace service DNS when running in another namespace', () => {
    expect(
      resolveAgentsBaseUrl({
        env: {},
        kubernetesNamespace: 'coder',
      }),
    ).toBe(DEFAULT_K8S_AGENTS_BASE_URL)
  })

  it('uses in-cluster DNS when Kubernetes service env is present', () => {
    expect(
      resolveAgentsBaseUrl({
        env: { KUBERNETES_SERVICE_HOST: '10.96.0.1' },
        kubernetesNamespace: null,
      }),
    ).toBe(DEFAULT_K8S_AGENTS_BASE_URL)
  })

  it('uses public Agents API default outside Kubernetes', () => {
    expect(
      resolveAgentsBaseUrl({
        env: {},
        kubernetesNamespace: null,
      }),
    ).toBe(DEFAULT_AGENTS_BASE_URL)
  })
})
