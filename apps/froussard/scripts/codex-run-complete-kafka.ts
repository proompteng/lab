#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { Kafka } from 'kafkajs'

type Args = {
  payloadPath: string
  topic: string
  key?: string
}

const parseArgs = (argv: string[]): Args => {
  let payloadPath = ''
  let topic = process.env.KAFKA_RUN_COMPLETE_TOPIC ?? process.env.KAFKA_TOPIC ?? 'argo.workflows.completions'
  let key: string | undefined

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg) continue
    if (arg === '--payload') {
      payloadPath = argv[++i] ?? ''
      continue
    }
    if (arg === '--topic') {
      topic = argv[++i] ?? topic
      continue
    }
    if (arg === '--key') {
      key = argv[++i]
    }
  }

  if (!payloadPath) {
    throw new Error('Missing required --payload <path>')
  }

  return { payloadPath, topic, key }
}

const parseBrokers = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)

const normalizeKey = (payload: Record<string, unknown>): string | undefined => {
  const meta =
    typeof payload.metadata === 'object' && payload.metadata ? (payload.metadata as Record<string, unknown>) : {}
  const uid = typeof meta.uid === 'string' ? meta.uid : null
  const name = typeof meta.name === 'string' ? meta.name : null
  return uid ?? name ?? undefined
}

const run = async () => {
  const { payloadPath, topic, key } = parseArgs(process.argv.slice(2))
  const brokers = parseBrokers(process.env.KAFKA_BROKERS)
  const username = process.env.KAFKA_USERNAME ?? ''
  const password = process.env.KAFKA_PASSWORD ?? ''

  if (brokers.length === 0) {
    throw new Error('KAFKA_BROKERS must be set to at least one broker host:port')
  }
  if (!username || !password) {
    throw new Error('KAFKA_USERNAME and KAFKA_PASSWORD must be set')
  }

  const payloadRaw = await readFile(payloadPath, 'utf8')
  const payload = JSON.parse(payloadRaw) as Record<string, unknown>

  const kafka = new Kafka({
    clientId: process.env.KAFKA_CLIENT_ID ?? 'codex-run-complete',
    brokers,
    ssl: false,
    sasl: {
      mechanism: 'scram-sha-512',
      username,
      password,
    },
  })

  const producer = kafka.producer({ allowAutoTopicCreation: false })
  await producer.connect()
  try {
    await producer.send({
      topic,
      messages: [
        {
          key: key ?? normalizeKey(payload),
          value: JSON.stringify(payload),
        },
      ],
    })
  } finally {
    await producer.disconnect()
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Failed to enqueue run-complete payload: ${message}`)
  process.exit(1)
})
