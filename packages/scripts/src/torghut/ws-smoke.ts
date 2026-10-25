#!/usr/bin/env bun

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureCli, fatal, run } from '../shared/cli'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const main = async () => {
  ensureCli('kubectl')
  ensureCli('kafka-console-consumer')

  const namespace = process.env.NAMESPACE ?? 'kafka'
  const topic = process.env.TOPIC ?? 'torghut.trades.v1'
  const username = process.env.KAFKA_USERNAME ?? fatal('KAFKA_USERNAME is required')
  const password = process.env.KAFKA_PASSWORD ?? fatal('KAFKA_PASSWORD is required')
  const securityProtocol = process.env.KAFKA_SECURITY_PROTOCOL ?? 'SASL_SSL'
  const saslMechanism = process.env.KAFKA_SASL_MECHANISM ?? 'SCRAM-SHA-512'
  const localPort = Number(process.env.LOCAL_KAFKA_PORT ?? '19093')
  const remotePort = Number(process.env.REMOTE_KAFKA_PORT ?? '9093')

  const tmpDir = mkdtempSync(join(tmpdir(), 'torghut-ws-smoke-'))
  const configPath = join(tmpDir, 'client.properties')
  writeFileSync(
    configPath,
    [
      `bootstrap.servers=localhost:${localPort}`,
      `security.protocol=${securityProtocol}`,
      `sasl.mechanism=${saslMechanism}`,
      `sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="${username}" password="${password}";`,
      'ssl.endpoint.identification.algorithm=HTTPS',
    ].join('\n'),
    'utf8',
  )

  const portForward = Bun.spawn(
    ['kubectl', '-n', namespace, 'port-forward', 'svc/kafka-kafka-bootstrap', `${localPort}:${remotePort}`],
    { stdout: 'pipe', stderr: 'inherit' },
  )

  await sleep(2000)
  if (portForward.exitCode !== null) {
    fatal('kubectl port-forward exited early; check cluster access and service name')
  }

  try {
    await run('kafka-console-consumer', [
      '--bootstrap-server',
      `localhost:${localPort}`,
      '--topic',
      topic,
      '--max-messages',
      process.env.MAX_MESSAGES ?? '5',
      '--timeout-ms',
      process.env.TIMEOUT_MS ?? '10000',
      '--consumer.config',
      configPath,
    ])
  } finally {
    portForward.kill()
    await portForward.exited
  }
}

if (import.meta.main) {
  main().catch((err) => fatal('Smoke test failed', err))
}
