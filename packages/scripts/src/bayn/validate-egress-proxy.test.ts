import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import { validateBaynEgressProxy } from './validate-egress-proxy'

const deployedConfig = readFileSync('argocd/applications/bayn/squid.conf', 'utf8')

describe('Bayn egress proxy contract', () => {
  test('allows only the exact trading, decision API and official public-source hosts over TLS CONNECT', () => {
    expect(validateBaynEgressProxy(deployedConfig)).toEqual({
      aclName: 'trading_api',
      openCodeAllowedHosts: ['opencode.ai'],
      allowedHosts: [
        'api.alpaca.markets',
        'api.openai.com',
        'api.typesafe.ai',
        'data.alpaca.markets',
        'data.sec.gov',
        'paper-api.alpaca.markets',
        'www.bls.gov',
        'www.federalreserve.gov',
        'www.sec.gov',
      ],
    })
  })

  test.each([
    ['wildcard domain', deployedConfig.replace('api.alpaca.markets', '.alpaca.markets')],
    [
      'shared OpenCode bypass',
      deployedConfig.replace('acl trading_api dstdomain ', 'acl trading_api dstdomain opencode.ai '),
    ],
    ['OpenCode listener bypass', deployedConfig.replace('http_access deny opencode_listener !opencode_api\n', '')],
    ['unrelated domain', deployedConfig.replace('api.alpaca.markets', 'example.com')],
    ['wildcard TypeSafe domain', deployedConfig.replace('api.typesafe.ai', '.typesafe.ai')],
    ['wildcard OpenCode domain', deployedConfig.replace('opencode.ai', '.opencode.ai')],
    ['unlisted OpenCode host', deployedConfig.replace('opencode.ai', 'console.opencode.ai')],
    ['wildcard OpenAI domain', deployedConfig.replace('api.openai.com', '.openai.com')],
    ['unrelated OpenAI frontend', deployedConfig.replace('api.openai.com', 'chatgpt.com')],
    ['duplicate replacing TypeSafe', deployedConfig.replace('api.typesafe.ai', 'api.alpaca.markets')],
    ['wildcard SEC domain', deployedConfig.replace('www.sec.gov', '.sec.gov')],
    ['unrelated research domain', deployedConfig.replace('www.bls.gov', 'example.com')],
    [
      'additional allow rule',
      deployedConfig.replace('http_access deny all', 'http_access allow all\nhttp_access deny all'),
    ],
    [
      'allow before deny',
      deployedConfig
        .replace('http_access allow CONNECT !opencode_listener trading_api\n', '')
        .replace(
          'http_access deny !CONNECT',
          'http_access allow CONNECT !opencode_listener trading_api\nhttp_access deny !CONNECT',
        ),
    ],
  ])('rejects %s expansion', (_name, config) => {
    expect(() => validateBaynEgressProxy(config)).toThrow()
  })
})
