#!/usr/bin/env bun

import { ensureCli, fatal } from '../shared/cli'

type Args = {
  topic?: string
  tail: number
  partition: number
  timeoutMs: number
  bootstrap: string
  securityProtocol: string
  saslMechanism: string
  username?: string
  password?: string
  passwordSecretName?: string
  passwordSecretNamespace: string
  passwordSecretKey: string
  kafkaNamespace: string
  kafkaPod?: string
  format: 'raw' | 'summary' | 'json'
}

const usage = () =>
  `
Usage:
  bun run packages/scripts/src/kafka/tail-topic.ts --topic <topic> [options]

Options:
  --topic <name>                      Kafka topic to read (required)
  --tail <n>                          Number of messages from the end (default: 1)
  --partition <n>                     Partition to read (default: 0)
  --timeout-ms <n>                    Consumer timeout in ms (default: 8000)

  --bootstrap <host:port>             Kafka bootstrap (default: kafka-kafka-bootstrap.kafka.svc:9092)
  --security-protocol <value>         Kafka security.protocol (default: SASL_PLAINTEXT)
  --sasl-mechanism <value>            Kafka sasl.mechanism (default: SCRAM-SHA-512)
  --username <value>                  SASL username (or env KAFKA_USERNAME)
  --password <value>                  SASL password (or env KAFKA_PASSWORD)

  --password-secret-name <name>       Read password from a k8s Secret key instead of --password
  --password-secret-namespace <ns>    Secret namespace (default: torghut)
  --password-secret-key <key>         Secret data key (default: password)

  --kafka-namespace <ns>              Namespace that contains the Kafka broker pod (default: kafka)
  --kafka-pod <pod>                   Kafka broker pod to exec into (default: auto-detect)

  --format raw|summary|json           Output format (default: summary)

Examples:
  KAFKA_USERNAME=torghut-ws KAFKA_PASSWORD=$(kubectl -n torghut get secret torghut-ws -o jsonpath='{.data.password}' | base64 -d) \\
    bun run packages/scripts/src/kafka/tail-topic.ts --topic torghut.bars.1m.v1 --tail 1

  KAFKA_USERNAME=torghut-ws \\
    bun run packages/scripts/src/kafka/tail-topic.ts --topic torghut.trades.v1 --tail 5 \\
    --password-secret-namespace torghut --password-secret-name torghut-ws --password-secret-key password
`.trim()

const parseArgs = (argv: string[]) => {
  const out: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue

    const trimmed = token.slice(2)
    const eq = trimmed.indexOf('=')
    if (eq !== -1) {
      const key = trimmed.slice(0, eq)
      const value = trimmed.slice(eq + 1)
      out[key] = value
      continue
    }

    const key = trimmed
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      out[key] = true
      continue
    }
    out[key] = next
    i += 1
  }
  return out
}

const parseIntArg = (value: unknown, fallback: number, name: string) => {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    fatal(`Invalid --${name}: ${String(value)}`)
  }
  return parsed
}

const decodeSecretData = (encoded: string) => Buffer.from(encoded, 'base64').toString('utf8')

const execCapture = async (
  command: string,
  args: string[],
  options: { stdin?: string; env?: Record<string, string | undefined> } = {},
) => {
  const subprocess = Bun.spawn([command, ...args], {
    stdin: options.stdin ? 'pipe' : 'inherit',
    stdout: 'pipe',
    stderr: 'pipe',
    env: options.env ? { ...process.env, ...options.env } : process.env,
  })

  if (options.stdin) {
    subprocess.stdin.write(options.stdin)
    subprocess.stdin.end()
  }

  const stdout = await new Response(subprocess.stdout).text()
  const stderr = await new Response(subprocess.stderr).text()
  const exitCode = await subprocess.exited
  if (exitCode !== 0) {
    fatal(`Command failed (${exitCode}): ${command} ${args.join(' ')}`.trim(), stderr || stdout)
  }
  return stdout
}

const kubectlJson = async <T>(args: string[]): Promise<T> => {
  const stdout = await execCapture('kubectl', [...args, '-o', 'json'])
  return JSON.parse(stdout) as T
}

const pickKafkaPod = async (namespace: string) => {
  const data = await kubectlJson<{ items: Array<{ metadata: { name: string } }> }>(['-n', namespace, 'get', 'pods'])
  const candidates = data.items
    .map((item) => item.metadata.name)
    .filter((name) => name.startsWith('kafka-pool-'))
    .sort()
  return (
    candidates[0] ?? fatal(`No Kafka broker pod found in namespace '${namespace}' (expected name like kafka-pool-*)`)
  )
}

const toSummary = (line: string) => {
  try {
    const env = JSON.parse(line) as {
      eventTs?: string
      feed?: string
      channel?: string
      symbol?: string
      seq?: number
      isFinal?: boolean
      payload?: Record<string, unknown>
    }

    const payload = env.payload ?? {}
    const channel = env.channel ?? '?'
    const symbol = env.symbol ?? '?'
    const eventTs = env.eventTs ?? '?'

    if (channel === 'trades') {
      const price = payload.p
      const size = payload.s
      return `${eventTs} ${symbol} trade p=${price ?? '?'} s=${size ?? '?'}`
    }

    if (channel === 'quotes') {
      const bid = payload.bp
      const ask = payload.ap
      return `${eventTs} ${symbol} quote bp=${bid ?? '?'} ap=${ask ?? '?'}`
    }

    if (channel === 'bars' || channel === 'updatedBars') {
      const o = payload.o
      const h = payload.h
      const l = payload.l
      const c = payload.c
      const v = payload.v
      return `${eventTs} ${symbol} ${channel} o=${o ?? '?'} h=${h ?? '?'} l=${l ?? '?'} c=${c ?? '?'} v=${v ?? '?'}`
    }

    if (channel === 'status') {
      const code = payload.statusCode ?? payload.sc
      const msg = payload.statusMessage ?? payload.sm
      return `${eventTs} ${symbol} status code=${code ?? '?'} msg=${msg ?? '?'}`
    }

    return `${eventTs} ${symbol} ${channel} (unhandled payload)`
  } catch {
    return line
  }
}

const main = async () => {
  ensureCli('kubectl')

  const raw = parseArgs(process.argv.slice(2))
  if (raw.help === true || raw.h === true) {
    console.log(usage())
    return
  }

  const args: Args = {
    topic: typeof raw.topic === 'string' ? raw.topic : undefined,
    tail: parseIntArg(raw.tail, 1, 'tail'),
    partition: parseIntArg(raw.partition, 0, 'partition'),
    timeoutMs: parseIntArg(raw['timeout-ms'], 8000, 'timeout-ms'),
    bootstrap:
      (typeof raw.bootstrap === 'string' ? raw.bootstrap : process.env.KAFKA_BOOTSTRAP) ??
      'kafka-kafka-bootstrap.kafka.svc:9092',
    securityProtocol:
      (typeof raw['security-protocol'] === 'string' ? raw['security-protocol'] : process.env.KAFKA_SECURITY_PROTOCOL) ??
      'SASL_PLAINTEXT',
    saslMechanism:
      (typeof raw['sasl-mechanism'] === 'string' ? raw['sasl-mechanism'] : process.env.KAFKA_SASL_MECHANISM) ??
      'SCRAM-SHA-512',
    username: (typeof raw.username === 'string' ? raw.username : process.env.KAFKA_USERNAME) ?? undefined,
    password: (typeof raw.password === 'string' ? raw.password : process.env.KAFKA_PASSWORD) ?? undefined,
    passwordSecretName: typeof raw['password-secret-name'] === 'string' ? raw['password-secret-name'] : undefined,
    passwordSecretNamespace:
      (typeof raw['password-secret-namespace'] === 'string' ? raw['password-secret-namespace'] : undefined) ??
      'torghut',
    passwordSecretKey:
      (typeof raw['password-secret-key'] === 'string' ? raw['password-secret-key'] : undefined) ?? 'password',
    kafkaNamespace: (typeof raw['kafka-namespace'] === 'string' ? raw['kafka-namespace'] : undefined) ?? 'kafka',
    kafkaPod: typeof raw['kafka-pod'] === 'string' ? raw['kafka-pod'] : undefined,
    format: (typeof raw.format === 'string' ? raw.format : undefined) as Args['format'],
  }

  args.format = args.format ?? 'summary'
  if (!['raw', 'summary', 'json'].includes(args.format)) {
    fatal(`Invalid --format: ${String(args.format)}`)
  }

  if (!args.topic) fatal('Missing --topic')
  if (!args.username) fatal('Missing --username (or env KAFKA_USERNAME)')

  if (!args.password) {
    if (!args.passwordSecretName) {
      fatal('Missing --password (or env KAFKA_PASSWORD), or provide --password-secret-name/namespace/key')
    }
    const encoded = await execCapture('kubectl', [
      '-n',
      args.passwordSecretNamespace,
      'get',
      'secret',
      args.passwordSecretName,
      '-o',
      `jsonpath={.data.${args.passwordSecretKey}}`,
    ])
    args.password = decodeSecretData(encoded.trim())
  }

  const kafkaPod = args.kafkaPod ?? (await pickKafkaPod(args.kafkaNamespace))

  const remoteScript = [
    'set -euo pipefail',
    'read -r PASS',
    'CLIENT=/tmp/kafka-client.properties',
    'cat > "$CLIENT" <<PROPS',
    'security.protocol=$SECURITY_PROTOCOL',
    'sasl.mechanism=$SASL_MECHANISM',
    'sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="$KAFKA_USERNAME" password="$PASS";',
    'PROPS',
    'end_offset=$(/opt/kafka/bin/kafka-get-offsets.sh --bootstrap-server "$BOOTSTRAP" --command-config "$CLIENT" --topic "$TOPIC" --time latest | awk -F: -v p="$PARTITION" \'$2==p{print $3}\' | tail -n 1)',
    'if [ -z "$end_offset" ]; then end_offset=0; fi',
    'start_offset=$(( end_offset - TAIL ))',
    'if [ "$start_offset" -lt 0 ]; then start_offset=0; fi',
    '/opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server "$BOOTSTRAP" --consumer.config "$CLIENT" --topic "$TOPIC" --partition "$PARTITION" --offset "$start_offset" --max-messages "$TAIL" --timeout-ms "$TIMEOUT_MS"',
  ].join('\n')

  const stdout = await execCapture(
    'kubectl',
    [
      '-n',
      args.kafkaNamespace,
      'exec',
      '-i',
      kafkaPod,
      '--',
      'env',
      `TOPIC=${args.topic}`,
      `TAIL=${args.tail}`,
      `PARTITION=${args.partition}`,
      `TIMEOUT_MS=${args.timeoutMs}`,
      `BOOTSTRAP=${args.bootstrap}`,
      `SECURITY_PROTOCOL=${args.securityProtocol}`,
      `SASL_MECHANISM=${args.saslMechanism}`,
      `KAFKA_USERNAME=${args.username}`,
      'bash',
      '-lc',
      remoteScript,
    ],
    { stdin: `${args.password}\n` },
  )

  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  if (args.format === 'raw') {
    process.stdout.write(lines.join('\n') + (lines.length ? '\n' : ''))
    return
  }

  if (args.format === 'json') {
    const parsed = lines.map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return { raw: line }
      }
    })
    process.stdout.write(`${JSON.stringify(parsed, null, 2)}\n`)
    return
  }

  // summary
  for (const line of lines) console.log(toSummary(line))
}

if (import.meta.main) {
  main().catch((err) => fatal('Kafka tail failed', err))
}
