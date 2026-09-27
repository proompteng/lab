import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import { validateBaynEgressProxy } from './validate-egress-proxy'

const deployedConfig = readFileSync('argocd/applications/bayn/squid.conf', 'utf8')

describe('Bayn egress proxy contract', () => {
  test('allows only the exact Alpaca and TypeSafe API hosts over TLS CONNECT', () => {
    expect(validateBaynEgressProxy(deployedConfig)).toEqual({
      aclName: 'trading_api',
      allowedHosts: ['api.alpaca.markets', 'api.typesafe.ai', 'data.alpaca.markets', 'paper-api.alpaca.markets'],
    })
  })

  test.each([
    ['wildcard domain', deployedConfig.replace('api.alpaca.markets', '.alpaca.markets')],
    ['unrelated domain', deployedConfig.replace('api.alpaca.markets', 'example.com')],
    ['wildcard TypeSafe domain', deployedConfig.replace('api.typesafe.ai', '.typesafe.ai')],
    ['duplicate replacing TypeSafe', deployedConfig.replace('api.typesafe.ai', 'api.alpaca.markets')],
    [
      'additional allow rule',
      deployedConfig.replace('http_access deny all', 'http_access allow all\nhttp_access deny all'),
    ],
    [
      'allow before deny',
      deployedConfig.replace(
        'http_access deny !trading_api\nhttp_access deny blocked_private_v4\nhttp_access deny blocked_private_v6\nhttp_access allow CONNECT trading_api',
        'http_access allow CONNECT trading_api\nhttp_access deny !trading_api\nhttp_access deny blocked_private_v4\nhttp_access deny blocked_private_v6',
      ),
    ],
  ])('rejects %s expansion', (_name, config) => {
    expect(() => validateBaynEgressProxy(config)).toThrow()
  })
})
