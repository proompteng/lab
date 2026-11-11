import { spawn } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http2'
import { describe, expect, test } from 'bun:test'
import * as restate from '@restatedev/restate-sdk'
import { Config, Effect, Redacted, Result, Schedule, Schema } from 'effect'

import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import {
  brokerNotificationVersion,
  SignedBrokerNotificationSchema,
  verifyBrokerNotification,
} from '../broker/notifications'
import { decodeExecutionWakeup, type ExecutionWakeup } from '../execution/events'
import { acquireRestateHttp2Server } from './restate-http2-server'
import { brokerObservationJsonSerde, makeBaynBrokerObservations } from './restate-broker-observations'

const enabled = Effect.runSync(Config.Boolean('BAYN_TEST_BROKER_KAFKA_INGRESS').pipe(Config.withDefault(false)))
const describeKafka = enabled ? describe : describe.skip
const adapterImage =
  'ghcr.io/restatedev/ingress-integration-kafka@sha256:20704c886ee4dcc4046bab1743dc424bb08b2317ce1bc6da55ce738345ce01b1'
const kafkaImage = 'confluentinc/cp-kafka:8.1.0'
const restateImage = 'docker.restate.dev/restatedev/restate:1.8.1'
const topic = 'bayn.broker-notifications.v1'
const group = 'bayn-broker-notifications-restate-v1'
const fixture = Result.getOrThrow(
  Schema.decodeUnknownResult(
    Schema.fromJsonString(
      Schema.Struct({
        description: Schema.String,
        accountId: Schema.String,
        keyId: Schema.String,
        secret: Schema.String,
        key: Schema.String,
        notification: SignedBrokerNotificationSchema,
      }),
    ),
  )(readFileSync(new URL('../../../dorvud/fixtures/bayn-broker-notification-v1.json', import.meta.url), 'utf8')),
)
const connection = {
  identity: Result.getOrThrow(
    makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      accountId: fixture.accountId,
    }),
  ),
  key: Redacted.make(fixture.keyId),
  secret: Redacted.make(fixture.secret),
}

const docker = (args: readonly string[], input?: string) =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn('docker', [...args], { signal, stdio: ['pipe', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
          stdout += chunk
        })
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
          stderr += chunk
        })
        child.once('error', reject)
        child.stdin.once('error', reject)
        child.once('close', (code) =>
          code === 0
            ? resolve(stdout.trim())
            : reject(new Error(`Local Docker command failed (${code}): ${stderr.slice(-8_000)}`)),
        )
        child.stdin.end(input)
      }),
    catch: (cause) => cause,
  })
const json = (url: string, body?: unknown) =>
  Effect.tryPromise({
    try: async (signal) => {
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
        throw new Error('Kafka integration HTTP targets must be local')
      const response = await fetch(url, {
        signal,
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
        headers: { 'content-type': 'application/json', accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`Local Restate returned ${response.status}: ${await response.text()}`)
      return response.json() as Promise<unknown>
    },
    catch: (cause) => cause,
  })
const waitFor = (check: () => Effect.Effect<boolean, unknown>) =>
  Effect.suspend(check).pipe(
    Effect.flatMap((ready) => (ready ? Effect.void : Effect.fail('local Kafka ingress has not converged'))),
    Effect.retry({ schedule: Schedule.spaced('200 millis'), times: 100 }),
  )
// Production retains bounded operation deadlines. Only this disposable endpoint requests replay after every suspension.
const alwaysReplay = <A extends { name: string }>(service: A): A => {
  const definition = service as A & { options?: restate.ObjectOptions }
  definition.options = { ...definition.options, inactivityTimeout: 0 }
  return service
}

describeKafka('Pinned Kafka adapter and actual broker notification ingress', () => {
  test('preserves Kafka routing and signed bytes, rejects foreign accounts, and deduplicates capture after acknowledgement', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const explicitDockerHost = yield* Config.String('DOCKER_HOST').pipe(Config.withDefault(''))
          const contextHost = yield* docker(['context', 'inspect', '--format', '{{(index .Endpoints "docker").Host}}'])
          for (const host of [explicitDockerHost, contextHost])
            if (host !== '' && !host.startsWith('unix://') && !host.startsWith('npipe://'))
              throw new Error('Kafka integration requires a local Docker engine')
          for (const image of [kafkaImage, restateImage, adapterImage]) yield* docker(['image', 'inspect', image])
          const suffix = randomUUID().slice(0, 8)
          const network = `bayn-kafka-proof-${suffix}`
          yield* Effect.acquireRelease(docker(['network', 'create', network]), () =>
            docker(['network', 'rm', network]).pipe(Effect.orDie),
          )
          const container = (name: string, image: string, args: readonly string[]) =>
            Effect.acquireRelease(
              docker(['run', '-d', '--pull=never', '--name', name, '--network', network, ...args, image]).pipe(
                Effect.onError(() => docker(['rm', '-f', name]).pipe(Effect.ignore)),
                Effect.as(name),
              ),
              (owned) => docker(['rm', '-f', owned]).pipe(Effect.orDie),
            )
          const kafka = yield* container(`bayn-kafka-proof-broker-${suffix}`, kafkaImage, [
            '--network-alias',
            'kafka',
            '--tmpfs',
            '/var/lib/kafka/data:rw,size=256m,mode=1777',
            '--tmpfs',
            '/tmp:rw,size=64m',
            '-e',
            'KAFKA_NODE_ID=1',
            '-e',
            'KAFKA_PROCESS_ROLES=broker,controller',
            '-e',
            'KAFKA_LISTENERS=PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093',
            '-e',
            'KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://kafka:9092',
            '-e',
            'KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
            '-e',
            'KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER',
            '-e',
            'KAFKA_CONTROLLER_QUORUM_VOTERS=1@kafka:9093',
            '-e',
            'KAFKA_INTER_BROKER_LISTENER_NAME=PLAINTEXT',
            '-e',
            'KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1',
            '-e',
            'KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1',
            '-e',
            'KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1',
            '-e',
            'KAFKA_LOG_DIRS=/var/lib/kafka/data',
            '-e',
            'KAFKA_HEAP_OPTS=-Xms128m -Xmx256m',
            '-e',
            'CLUSTER_ID=MkU3OEVBNTcwNTJENDM2Qk',
          ])
          const core = yield* container(`bayn-kafka-proof-restate-${suffix}`, restateImage, [
            '--network-alias',
            'restate',
            '--tmpfs',
            '/restate-data:rw,size=512m',
            '-p',
            '127.0.0.1::8080',
            '-p',
            '127.0.0.1::9070',
            '-e',
            'RESTATE_BASE_DIR=/restate-data',
            '-e',
            'DO_NOT_TRACK=1',
          ])
          const ingress = `http://${yield* docker(['port', core, '8080/tcp'])}`
          const admin = `http://${yield* docker(['port', core, '9070/tcp'])}`
          yield* waitFor(() => json(`${admin}/deployments`).pipe(Effect.result, Effect.map(Result.isSuccess)))
          yield* waitFor(() =>
            docker(['exec', kafka, 'kafka-topics', '--bootstrap-server', 'kafka:9092', '--list']).pipe(
              Effect.result,
              Effect.map(Result.isSuccess),
            ),
          )
          yield* docker([
            'exec',
            kafka,
            'kafka-topics',
            '--bootstrap-server',
            'kafka:9092',
            '--create',
            '--topic',
            topic,
            '--partitions',
            '1',
            '--replication-factor',
            '1',
          ])
          let captures = 0
          let invalidations = 0
          let receiptWrites = 0
          const receipts = new Map<string, boolean>()
          const verified: { readonly candidate: unknown; readonly accepted: boolean; readonly reason?: string }[] = []
          const config = {
            controllerKey: fixture.key,
            sourceRevision: '2'.repeat(40),
            maxAgeMs: 60_000,
            freshnessLeadMs: 5_000,
            operationTimeoutMs: 5_000,
          }
          const owner = alwaysReplay(
            makeBaynBrokerObservations(config, {
              verifyNotification: (candidate, nowMs) => {
                const result = verifyBrokerNotification(candidate, connection, nowMs)
                verified.push(
                  Result.isSuccess(result)
                    ? { candidate, accepted: true }
                    : { candidate, accepted: false, reason: result.failure.reason },
                )
                return result
              },
              activate: async () => undefined,
              recordNotification: async (_signal, receipt) => {
                receiptWrites += 1
                const covered = receipts.get(receipt.eventId) ?? false
                receipts.set(receipt.eventId, covered)
                return { covered }
              },
              invalidate: async () => {
                invalidations += 1
              },
              poll: async () => {
                const now = Date.now()
                captures += 1
                for (const eventId of receipts.keys()) receipts.set(eventId, true)
                return {
                  poll: {
                    _tag: 'Published',
                    snapshotHash: captures.toString(16).padStart(64, '0'),
                    observedAt: new Date(now).toISOString(),
                    nextPollNotBeforeMs: now,
                  },
                  startedAtMs: now,
                  completedAtMs: now,
                }
              },
            }),
          )
          const receiver = alwaysReplay(
            restate.object({
              name: 'BaynExecutionController',
              handlers: {
                wake: async (ctx: restate.ObjectContext, candidate: unknown) => {
                  if (ctx.key !== config.controllerKey) throw new restate.TerminalError('unexpected Kafka routing key')
                  const wake = Result.getOrThrow(decodeExecutionWakeup(candidate))
                  ctx.set('wakes', [...((await ctx.get<ExecutionWakeup[]>('wakes')) ?? []), wake])
                },
                status: restate.handlers.object.shared((ctx: restate.ObjectSharedContext) =>
                  ctx.get<ExecutionWakeup[]>('wakes'),
                ),
              },
              options: { ingressPrivate: true },
            }),
          )
          const bridge = alwaysReplay(
            restate.service({
              name: 'KafkaIngressTestBridge',
              handlers: {
                activate: (ctx: restate.Context) =>
                  ctx.genericCall({
                    service: owner.name,
                    method: 'activate',
                    key: config.controllerKey,
                    parameter: { sourceRevision: config.sourceRevision },
                    inputSerde: brokerObservationJsonSerde,
                    outputSerde: brokerObservationJsonSerde,
                  }),
                status: (ctx: restate.Context) =>
                  ctx.genericCall({
                    service: owner.name,
                    method: 'status',
                    key: config.controllerKey,
                    parameter: {},
                    inputSerde: brokerObservationJsonSerde,
                    outputSerde: brokerObservationJsonSerde,
                  }),
                wakes: (ctx: restate.Context) =>
                  ctx.genericCall({
                    service: receiver.name,
                    method: 'status',
                    key: config.controllerKey,
                    parameter: {},
                    inputSerde: brokerObservationJsonSerde,
                    outputSerde: brokerObservationJsonSerde,
                  }),
              },
            }),
          )
          const server = createServer(restate.createEndpointHandler({ services: [owner, receiver, bridge] }))
          yield* acquireRestateHttp2Server(server, 0)
          const address = server.address()
          if (address === null || typeof address === 'string') throw new Error('Missing local endpoint address')
          yield* json(`${admin}/deployments`, { uri: `http://host.docker.internal:${address.port}` })
          expect(yield* json(`${admin}/services/${owner.name}`)).toMatchObject({ inactivity_timeout: '0s' })
          const invoke = (method: string) => json(`${ingress}/${bridge.name}/${method}`, {})
          yield* invoke('activate')
          expect(captures).toBe(1)
          for (const method of ['activate', 'accept', 'refresh', 'capture', 'freshness', 'status']) {
            const denied = yield* Effect.promise(() =>
              fetch(`${ingress}/${owner.name}/${config.controllerKey}/${method}`, {
                method: 'POST',
                body: '{}',
                headers: { 'content-type': 'application/json' },
              }),
            )
            expect(denied.status).toBe(400)
          }
          const adapter = yield* container(`bayn-kafka-proof-adapter-${suffix}`, adapterImage, [
            '--platform',
            'linux/amd64',
            '--tmpfs',
            '/tmp:rw,size=64m',
            '-e',
            'KAFKA_BOOTSTRAP_SERVERS=kafka:9092',
            '-e',
            `KAFKA_GROUP_ID=${group}`,
            '-e',
            `KAFKA_TOPICS=${topic}`,
            '-e',
            'KAFKA_SECURITY_PROTOCOL=PLAINTEXT',
            '-e',
            'KAFKA_AUTO_OFFSET_RESET=earliest',
            '-e',
            'RESTATE_INGRESS_URL=http://restate:8080',
            '-e',
            'RESTATE_RECORD_MAPPER_CLASS=dev.restate.integration.kafka.mapper.StaticRecordMapper',
            '-e',
            `RESTATE_RECORD_MAPPER_SERVICE=${owner.name}`,
            '-e',
            'RESTATE_RECORD_MAPPER_HANDLER=notify',
            '-e',
            'RESTATE_RECORD_MAPPER_KAFKA_METADATA=true',
            '-e',
            'RESTATE_KAFKA_CONSUMER_INSTANCES=1',
            '-e',
            'JDK_JAVA_OPTIONS=-Xmx256m',
          ])
          const message = JSON.parse(fixture.notification.message) as { session: { accountId: string } }
          message.session.accountId = '00000000-0000-4000-8000-000000000003'
          const foreignMessage = JSON.stringify(message)
          const foreign = {
            ...fixture.notification,
            message: foreignMessage,
            signature: createHmac('sha256', fixture.secret)
              .update(`${brokerNotificationVersion}\n${foreignMessage}`)
              .digest('hex'),
          }
          const records: readonly (readonly [string, unknown])[] = [
            [fixture.key, fixture.notification],
            [fixture.key, fixture.notification],
            [fixture.key, foreign],
            [fixture.key, { ...fixture.notification, signature: 'f'.repeat(64) }],
            ['f'.repeat(64), fixture.notification],
          ]
          const produce = (entries: readonly (readonly [string, unknown])[]) =>
            docker(
              [
                'exec',
                '-i',
                kafka,
                'kafka-console-producer',
                '--bootstrap-server',
                'kafka:9092',
                '--topic',
                topic,
                '--property',
                'parse.key=true',
                '--property',
                'key.separator=|',
                '--producer-property',
                'acks=all',
                '--producer-property',
                'enable.idempotence=true',
              ],
              entries.map(([recordKey, value]) => `${recordKey}|${JSON.stringify(value)}`).join('\n') + '\n',
            )
          yield* produce(records)
          yield* waitFor(() => Effect.sync(() => verified.length === 4 && captures === 2))
          expect(verified.filter((record) => record.accepted).map((record) => record.candidate)).toEqual([
            fixture.notification,
            fixture.notification,
          ])
          expect(
            verified
              .filter((record) => !record.accepted)
              .map((record) => record.reason)
              .sort((left, right) => (left ?? '').localeCompare(right ?? '')),
          ).toEqual(['account', 'signature'])
          expect(invalidations).toBe(1)
          expect(receiptWrites).toBe(2)
          expect(receipts.size).toBe(1)
          expect([...receipts.values()]).toEqual([true])
          const offsets = () =>
            docker([
              'exec',
              kafka,
              'kafka-consumer-groups',
              '--bootstrap-server',
              'kafka:9092',
              '--group',
              group,
              '--describe',
            ])
          yield* waitFor(() =>
            offsets().pipe(
              Effect.map((output) =>
                output
                  .split('\n')
                  .some((line) => new RegExp(`${topic.replaceAll('.', '\\.')}\\s+0\\s+5\\s+5\\s+0`).test(line)),
              ),
            ),
          )
          yield* docker(['restart', adapter])
          yield* produce([[fixture.key, fixture.notification]])
          yield* waitFor(() => Effect.sync(() => verified.length === 5 && receiptWrites === 3))
          yield* waitFor(() =>
            offsets().pipe(
              Effect.map((output) =>
                output
                  .split('\n')
                  .some((line) => new RegExp(`${topic.replaceAll('.', '\\.')}\\s+0\\s+6\\s+6\\s+0`).test(line)),
              ),
            ),
          )
          expect(captures).toBe(2)
          expect(invalidations).toBe(1)
          expect(yield* invoke('status')).toMatchObject({ captureScheduled: false, sequence: 3 })
          const wakes = yield* invoke('wakes')
          expect(wakes).toMatchObject([
            { _tag: 'BrokerObservation', sourceRevision: config.sourceRevision, snapshotHash: '1'.padStart(64, '0') },
            { _tag: 'BrokerObservation', sourceRevision: config.sourceRevision, snapshotHash: '2'.padStart(64, '0') },
          ])
          expect(
            yield* json(`${admin}/query`, {
              query: `SELECT COUNT(*) AS accepted FROM sys_invocation WHERE target_service_name = '${owner.name}' AND target_service_key = '${config.controllerKey}' AND target_handler_name = 'accept'`,
            }),
          ).toEqual({ rows: [{ accepted: 1 }] })
        }),
      ).pipe(Effect.timeout('90 seconds')),
    )
  }, 120_000)
})
