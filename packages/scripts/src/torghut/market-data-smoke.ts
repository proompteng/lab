#!/usr/bin/env bun

import { ensureCli, fatal, run } from '../shared/cli'

const parseList = (raw: string | undefined, fallback: string[]) =>
  raw
    ?.split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0) ?? fallback

const main = async () => {
  ensureCli('kubectl')

  const topics = parseList(process.env.TORGHUT_MARKET_DATA_TOPICS, [
    'torghut.trades.v1',
    'torghut.quotes.v1',
    'torghut.bars.1m.v1',
    'torghut.ta.bars.1s.v1',
    'torghut.ta.signals.v1',
    'torghut.ta.status.v1',
  ])
  const username = process.env.KAFKA_USERNAME ?? 'torghut-ws'
  const passwordSecretNamespace = process.env.KAFKA_PASSWORD_SECRET_NAMESPACE ?? 'torghut'
  const passwordSecretName = process.env.KAFKA_PASSWORD_SECRET_NAME ?? 'torghut-ws'
  const passwordSecretKey = process.env.KAFKA_PASSWORD_SECRET_KEY ?? 'password'
  const tail = process.env.TAIL ?? '1'
  const timeoutMs = process.env.TIMEOUT_MS ?? '8000'

  for (const topic of topics) {
    await run('bun', [
      'run',
      'packages/scripts/src/kafka/tail-topic.ts',
      '--topic',
      topic,
      '--tail',
      tail,
      '--timeout-ms',
      timeoutMs,
      '--username',
      username,
      '--password-secret-namespace',
      passwordSecretNamespace,
      '--password-secret-name',
      passwordSecretName,
      '--password-secret-key',
      passwordSecretKey,
      '--format',
      'summary',
    ])
  }
}

if (import.meta.main) {
  main().catch((err) => fatal('Torghut market-data smoke failed', err))
}
