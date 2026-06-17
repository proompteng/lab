import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import YAML from 'yaml'

import { repoRoot } from '../../shared/cli'

type ConfigMapManifest = {
  data?: Record<string, string>
}

const configManifestPath = 'argocd/applications/torghut-hyperliquid-feed/configmap.yaml'

const readConfigData = (): Record<string, string> => {
  const manifest = YAML.parse(readFileSync(join(repoRoot, configManifestPath), 'utf8')) as ConfigMapManifest
  if (!manifest.data) {
    throw new Error(`Missing data in ${configManifestPath}`)
  }
  return manifest.data
}

describe('Torghut Hyperliquid feed config', () => {
  it('keeps live websocket coverage inside the production subscription budget', () => {
    const config = readConfigData()

    expect(config.HYPERLIQUID_MARKET_COVERAGE).toBe('canary')
    expect(config.HYPERLIQUID_CANARY_COINS).toBe('BTC,ETH,SOL,HYPE')
    expect(Number(config.HYPERLIQUID_MAX_TOTAL_SUBSCRIPTIONS)).toBeLessThanOrEqual(1000)
    expect(config.HYPERLIQUID_WS_CHANNELS).toBe('allMids,trades,l2Book,bbo,candle,activeAssetCtx,allDexsAssetCtxs')
  })
})
