import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_JANGAR_BASE_URL,
  DEFAULT_K8S_JANGAR_BASE_URL,
  DEFAULT_K8S_SAME_NAMESPACE_JANGAR_BASE_URL,
  parseCliFlags,
  parseCommaList,
  parseJson,
  resolveJangarBaseUrl,
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

describe('resolveJangarBaseUrl', () => {
  it('uses explicit override env vars and trims trailing slash', () => {
    expect(
      resolveJangarBaseUrl({
        env: { MEMORIES_JANGAR_URL: 'http://custom.example/' },
        kubernetesNamespace: null,
      }),
    ).toBe('http://custom.example')
  })

  it('uses in-namespace service when running inside jangar namespace', () => {
    expect(
      resolveJangarBaseUrl({
        env: {},
        kubernetesNamespace: 'jangar',
      }),
    ).toBe(DEFAULT_K8S_SAME_NAMESPACE_JANGAR_BASE_URL)
  })

  it('uses cross-namespace service DNS when running in another namespace', () => {
    expect(
      resolveJangarBaseUrl({
        env: {},
        kubernetesNamespace: 'coder',
      }),
    ).toBe(DEFAULT_K8S_JANGAR_BASE_URL)
  })

  it('uses in-cluster DNS when Kubernetes service env is present', () => {
    expect(
      resolveJangarBaseUrl({
        env: { KUBERNETES_SERVICE_HOST: '10.96.0.1' },
        kubernetesNamespace: null,
      }),
    ).toBe(DEFAULT_K8S_JANGAR_BASE_URL)
  })

  it('uses tailscale hostname default outside Kubernetes', () => {
    expect(
      resolveJangarBaseUrl({
        env: {},
        kubernetesNamespace: null,
      }),
    ).toBe(DEFAULT_JANGAR_BASE_URL)
  })
})
