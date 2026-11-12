import { spawn } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { connect, createServer, type IncomingHttpHeaders, type ServerHttp2Stream } from 'node:http2'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'
import * as restate from '@restatedev/restate-sdk'
import { Config, Effect, Exit, Redacted, Result, Schedule, Schema, Scope } from 'effect'

import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import {
  BrokerNotificationSchema,
  brokerNotificationVersion,
  SignedBrokerNotificationSchema,
  verifyBrokerNotification,
} from '../broker/notifications'
import { decodeExecutionWakeup, type ExecutionWakeup } from '../execution/events'
import { sha256 } from '../hash'
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
const saslUser = 'bayn-local-proof'
const saslPassword = 'synthetic-local-kafka-proof'
const jaas = `org.apache.kafka.common.security.scram.ScramLoginModule required username="${saslUser}" password="${saslPassword}";`
const clientConfig = '/tmp/bayn-proof-client.properties'
const healthScriptPath = fileURLToPath(
  new URL('../../../../argocd/applications/bayn/broker-kafka-health.sh', import.meta.url),
)
const healthScriptSha256 = sha256(readFileSync(healthScriptPath, 'utf8'))
const HealthDeploymentSchema = Schema.Struct({
  spec: Schema.Struct({
    template: Schema.Struct({
      spec: Schema.Struct({
        containers: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            livenessProbe: Schema.Struct({
              exec: Schema.Struct({ command: Schema.Array(Schema.String) }),
              periodSeconds: Schema.Int,
              failureThreshold: Schema.Int,
            }),
          }),
        ),
      }),
    }),
  }),
})
const healthDeployment = Result.getOrThrow(
  Schema.decodeUnknownResult(HealthDeploymentSchema)(
    Bun.YAML.parse(
      readFileSync(new URL('../../../../argocd/applications/bayn/broker-kafka-ingress.yaml', import.meta.url), 'utf8'),
    ),
  ),
)
const healthPolicy = healthDeployment.spec.template.spec.containers.find(
  (container) => container.name === 'kafka-ingress',
)?.livenessProbe
if (healthPolicy === undefined) throw new Error('Missing broker ingress liveness policy')
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
const notification = Result.getOrThrow(
  Schema.decodeUnknownResult(Schema.fromJsonString(BrokerNotificationSchema))(fixture.notification.message),
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
const sign = (candidate: unknown) => {
  const message = JSON.stringify(candidate)
  return {
    schemaVersion: 'bayn.signed-broker-notification.v1',
    message,
    signature: createHmac('sha256', fixture.secret).update(`${brokerNotificationVersion}\n${message}`).digest('hex'),
  }
}
const ready = (sessionId: string) =>
  sign({
    schemaVersion: brokerNotificationVersion,
    _tag: 'SessionReady',
    eventId: sha256(`${fixture.key}\n${sessionId}\nready`),
    session: { ...notification.session, sessionId },
    receivedAt: notification.receivedAt,
  })
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
const response = (url: string, body?: unknown) =>
  Effect.tryPromise({
    try: async (signal) => {
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
        throw new Error('Kafka integration HTTP targets must be local')
      return fetch(url, {
        signal,
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
        headers: { 'content-type': 'application/json', accept: 'application/json' },
      })
    },
    catch: (cause) => cause,
  })
const json = (url: string, body?: unknown) =>
  response(url, body).pipe(
    Effect.flatMap((result) =>
      Effect.tryPromise({
        try: async () => {
          if (!result.ok) throw new Error(`Local Restate returned ${result.status}: ${await result.text()}`)
          return result.json() as Promise<unknown>
        },
        catch: (cause) => cause,
      }),
    ),
  )
const waitFor = (check: () => Effect.Effect<boolean, unknown>, times = 100) =>
  Effect.suspend(check).pipe(
    Effect.flatMap((ready) => (ready ? Effect.void : Effect.fail('local Kafka ingress has not converged'))),
    Effect.retry({ schedule: Schedule.spaced('200 millis'), times }),
  )
const alwaysReplay = <A extends { name: string }>(service: A): A => {
  const definition = service as A & { options?: restate.ObjectOptions }
  definition.options = { ...definition.options, inactivityTimeout: 0 }
  return service
}
const QuerySchema = Schema.Struct({ rows: Schema.Array(Schema.Struct({ id: Schema.String, status: Schema.String })) })

// IngestionResponse.error(kind=BAD_REQUEST=4, no invocation_offset), framed as one gRPC message.
// This is the actual stream-scoped protocol error, not an HTTP failure or terminal handler result.
const terminalStreamError = (stream: ServerHttp2Stream, kind = 4) => {
  const error = Buffer.concat([Buffer.from([0x10, kind, 0x1a, 0x0b]), Buffer.from('proof fault')])
  const payload = Buffer.concat([Buffer.from([0x1a, error.length]), error])
  const header = Buffer.alloc(5)
  header.writeUInt32BE(payload.length, 1)
  if (!stream.headersSent)
    stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true })
  if (stream.listenerCount('wantTrailers') === 0)
    stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }))
  stream.end(Buffer.concat([header, payload]))
}

describeKafka('Pinned Kafka adapter and actual broker notification ingress', () => {
  test('retains source offsets through outages, retries durable receipts, and recovers ingestion after stream failure and rebalance', async () => {
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
          const evidence = `/tmp/bayn-broker-kafka-${suffix}`
          yield* Effect.acquireRelease(docker(['network', 'create', network]), () =>
            docker(['network', 'rm', network]).pipe(Effect.orDie),
          )
          const container = (
            name: string,
            image: string,
            args: readonly string[],
            command: readonly string[] = [],
            namespace = network,
          ) =>
            Effect.acquireRelease(
              docker([
                'run',
                '-d',
                '--pull=never',
                '--name',
                name,
                '--network',
                namespace,
                ...args,
                image,
                ...command,
              ]).pipe(
                Effect.onError(() => docker(['rm', '-f', name]).pipe(Effect.ignore)),
                Effect.as(name),
              ),
              (owned) =>
                docker(['logs', owned]).pipe(
                  Effect.tap((log) => Effect.sync(() => writeFileSync(`${evidence}-${owned}.log`, log))),
                  Effect.ignore,
                  Effect.andThen(docker(['rm', '-f', owned]).pipe(Effect.orDie)),
                ),
            )
          // Only bootstrap/admin setup uses INTERNAL. All application traffic and offset inspection authenticate
          // over the production SASL_PLAINTEXT / SCRAM-SHA-512 mechanism with disposable synthetic credentials.
          const kafka = yield* container(
            `bayn-kafka-proof-broker-${suffix}`,
            kafkaImage,
            [
              '--network-alias',
              'kafka',
              '--tmpfs',
              '/var/lib/kafka/data:rw,size=256m,mode=1777',
              '--tmpfs',
              '/tmp:rw,size=64m',
              '--entrypoint',
              '/bin/bash',
              '-e',
              'KAFKA_NODE_ID=1',
              '-e',
              'KAFKA_PROCESS_ROLES=broker,controller',
              '-e',
              'KAFKA_LISTENERS=SASL_PLAINTEXT://0.0.0.0:9092,INTERNAL://0.0.0.0:9094,CONTROLLER://0.0.0.0:9093',
              '-e',
              'KAFKA_ADVERTISED_LISTENERS=SASL_PLAINTEXT://kafka:9092,INTERNAL://kafka:9094',
              '-e',
              'KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=CONTROLLER:PLAINTEXT,INTERNAL:PLAINTEXT,SASL_PLAINTEXT:SASL_PLAINTEXT',
              '-e',
              'KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER',
              '-e',
              'KAFKA_CONTROLLER_QUORUM_VOTERS=1@kafka:9093',
              '-e',
              'KAFKA_INTER_BROKER_LISTENER_NAME=INTERNAL',
              '-e',
              'KAFKA_SASL_ENABLED_MECHANISMS=SCRAM-SHA-512',
              '-e',
              'KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1',
              '-e',
              'KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1',
              '-e',
              'KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1',
              '-e',
              'KAFKA_LOG_DIRS=/var/lib/kafka/data',
              '-e',
              'KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS=0',
              '-e',
              'KAFKA_HEAP_OPTS=-Xms128m -Xmx256m',
              '-e',
              'KAFKA_OPTS=-Djava.security.auth.login.config=/tmp/bayn-proof-jaas.conf',
              '-e',
              'CLUSTER_ID=MkU3OEVBNTcwNTJENDM2Qk',
            ],
            [
              '-c',
              `cat > /tmp/bayn-proof-jaas.conf <<'JAAS'\nKafkaServer { ${jaas} };\nJAAS\ncat > ${clientConfig} <<'CLIENT'\nsecurity.protocol=SASL_PLAINTEXT\nsasl.mechanism=SCRAM-SHA-512\nsasl.jaas.config=${jaas}\ndefault.api.timeout.ms=10000\nrequest.timeout.ms=5000\nCLIENT\nexec /etc/confluent/docker/run`,
            ],
          )
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
            docker(['exec', kafka, 'kafka-topics', '--bootstrap-server', 'kafka:9094', '--list']).pipe(
              Effect.result,
              Effect.map(Result.isSuccess),
            ),
          )
          yield* docker([
            'exec',
            kafka,
            'kafka-configs',
            '--bootstrap-server',
            'kafka:9094',
            '--alter',
            '--add-config',
            `SCRAM-SHA-512=[password=${saslPassword}]`,
            '--entity-type',
            'users',
            '--entity-name',
            saslUser,
          ])
          const commandConfig = ['--bootstrap-server', 'kafka:9092', '--command-config', clientConfig] as const
          yield* docker([
            'exec',
            kafka,
            'kafka-topics',
            ...commandConfig,
            '--create',
            '--topic',
            topic,
            '--partitions',
            '1',
            '--replication-factor',
            '1',
          ])
          yield* docker([
            'exec',
            kafka,
            'bash',
            '-c',
            `sed 's/${saslPassword}/incorrect-proof-password/' ${clientConfig} > /tmp/bayn-proof-rejected.properties`,
          ])
          const rejectedSasl = yield* docker([
            'exec',
            kafka,
            'kafka-topics',
            '--bootstrap-server',
            'kafka:9092',
            '--command-config',
            '/tmp/bayn-proof-rejected.properties',
            '--list',
          ]).pipe(Effect.result)
          expect(Result.isFailure(rejectedSasl)).toBe(true)
          if (Result.isFailure(rejectedSasl))
            expect(String(rejectedSasl.failure)).toContain('SaslAuthenticationException')
          let captures = 0
          let notificationCaptures = 0
          let completenessCaptures = 0
          let invalidations = 0
          let receiptAttempts = 0
          let receiptBlocked = true
          const receipts = new Map<string, boolean>()
          const verified: { candidate: unknown; accepted: boolean; reason?: string }[] = []
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
                receiptAttempts++
                if (receiptBlocked) throw new Error('Injected transient SQL receipt outage')
                const covered = receipts.get(receipt.eventId) ?? false
                receipts.set(receipt.eventId, covered)
                return { covered }
              },
              invalidate: async () => {
                invalidations++
              },
              poll: async () => {
                const now = Date.now()
                captures++
                if ([...receipts.values()].some((covered) => !covered)) notificationCaptures++
                else if (captures > 1) completenessCaptures++
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
            const denied = yield* response(`${ingress}/${owner.name}/${config.controllerKey}/${method}`, {})
            expect(denied.status).toBe(400)
          }
          const upstream = yield* Effect.acquireRelease(
            Effect.sync(() => {
              const session = connect(ingress)
              session.on('error', () => undefined)
              return session
            }),
            (session) => Effect.sync(() => session.destroy()),
          )
          let fault = false
          let streamFaults = 0
          let openedStreams = 0
          const activeStreams = new Map<ServerHttp2Stream, ReturnType<typeof upstream.request>>()
          const proxy = createServer()
          proxy.on('stream', (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
            if (fault) {
              streamFaults++
              terminalStreamError(stream)
              return
            }
            const request = upstream.request({ ...headers, ':authority': new URL(ingress).host })
            openedStreams++
            activeStreams.set(stream, request)
            let trailers: Record<string, string | string[] | undefined> = { 'grpc-status': '0' }
            request.on('response', (reply) => stream.respond(reply, { waitForTrailers: true }))
            request.on('trailers', (reply) => {
              trailers = reply
            })
            stream.on('wantTrailers', () => {
              if (!stream.destroyed) stream.sendTrailers(trailers)
            })
            request.on('error', () => stream.close())
            stream.on('error', () => request.close())
            stream.on('close', () => {
              activeStreams.delete(stream)
              request.close()
            })
            stream.pipe(request)
            request.pipe(stream)
          })
          const failActiveStreams = (kind: number) => {
            for (const [stream, request] of activeStreams) {
              request.unpipe(stream)
              stream.unpipe(request)
              request.removeAllListeners('response')
              request.removeAllListeners('trailers')
              request.removeAllListeners('error')
              request.on('error', () => undefined)
              terminalStreamError(stream, kind)
              request.close()
            }
          }
          yield* acquireRestateHttp2Server(proxy, 0)
          const proxyAddress = proxy.address()
          if (proxyAddress === null || typeof proxyAddress === 'string')
            throw new Error('Missing local fault proxy address')
          const adapterArgs = [
            '--platform',
            'linux/amd64',
            '--user',
            '65532:65532',
            '--read-only',
            '--cap-drop',
            'ALL',
            '--security-opt',
            'no-new-privileges',
            '--mount',
            `type=bind,source=${healthScriptPath},target=/opt/bayn/health/probe.sh,readonly`,
            '--tmpfs',
            '/tmp:rw,size=64m',
            '-p',
            '127.0.0.1::9464',
            '-e',
            'KAFKA_BOOTSTRAP_SERVERS=kafka:9092',
            '-e',
            `KAFKA_GROUP_ID=${group}`,
            '-e',
            `KAFKA_TOPICS=${topic}`,
            '-e',
            'KAFKA_SECURITY_PROTOCOL=SASL_PLAINTEXT',
            '-e',
            'KAFKA_SASL_MECHANISM=SCRAM-SHA-512',
            '-e',
            `KAFKA_SASL_JAAS_CONFIG=${jaas}`,
            '-e',
            'KAFKA_AUTO_OFFSET_RESET=earliest',
            '-e',
            'KAFKA_SESSION_TIMEOUT_MS=6000',
            '-e',
            'KAFKA_HEARTBEAT_INTERVAL_MS=1000',
            '-e',
            'KAFKA_METADATA_MAX_AGE_MS=1000',
            '-e',
            `RESTATE_INGRESS_URL=http://host.docker.internal:${proxyAddress.port}`,
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
          ]
          const adapter = yield* container(`bayn-kafka-proof-adapter-${suffix}`, adapterImage, adapterArgs)
          expect(yield* docker(['exec', adapter, '/usr/bin/id', '-u'])).toBe('65532')
          expect(yield* docker(['exec', adapter, '/usr/bin/awk', '/^CapEff:/{print $2}', '/proc/self/status'])).toBe(
            '0000000000000000',
          )
          expect(yield* docker(['inspect', '--format', '{{.HostConfig.ReadonlyRootfs}}', adapter])).toBe('true')
          expect(
            (yield* docker(['exec', adapter, '/usr/bin/sha256sum', '/opt/bayn/health/probe.sh'])).split(/\s+/)[0],
          ).toBe(healthScriptSha256)
          const probe = (name: string, port?: number) =>
            docker([
              'exec',
              ...(port === undefined ? [] : ['-e', `RESTATE_METRICS_PORT=${port}`]),
              name,
              ...healthPolicy.exec.command,
            ])
          const metrics = (member = adapter) =>
            docker(['port', member, '9464/tcp']).pipe(
              Effect.flatMap((address) => response(`http://${address}/metrics`)),
              Effect.flatMap((result) => {
                expect(result.status).toBe(200)
                return Effect.promise(() => result.text())
              }),
            )
          const produce = (entries: readonly (readonly [string, unknown])[]) =>
            docker(
              [
                'exec',
                '-i',
                kafka,
                'kafka-console-producer',
                '--bootstrap-server',
                'kafka:9092',
                '--producer.config',
                clientConfig,
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
              entries.map(([key, value]) => `${key}|${JSON.stringify(value)}`).join('\n') + '\n',
            )
          const offsets = () =>
            docker(['exec', kafka, 'kafka-consumer-groups', ...commandConfig, '--group', group, '--describe'])
          const committed = (output: string): number | null => {
            const row = output.split('\n').find((line) => line.includes(topic))
            const columns = row?.trim().split(/\s+/)
            const value = columns?.[3]
            return value === undefined || value === '-' ? null : Number(value)
          }
          const atOffset = (offset: number) =>
            waitFor(() => offsets().pipe(Effect.map((output) => committed(output) === offset)))
          yield* waitFor(() => Effect.sync(() => activeStreams.size === 1))
          const healthyMetrics = yield* metrics()
          expect(healthyMetrics).toMatch(/^kafka_consumer_coordinator_assigned_partitions\{[^\n]*\} 1\.0$/m)
          expect(healthyMetrics).toMatch(/^vertx_http_client_active_requests\{method="POST"\} 1\.0$/m)
          writeFileSync(`${evidence}-healthy-quiet.prom`, healthyMetrics)
          process.stdout.write(`BROKER_KAFKA_HEALTHY_METRICS=${evidence}-healthy-quiet.prom\n`)
          yield* probe(adapter)
          const stallScope = yield* Scope.fork(yield* Effect.scope)
          const stall = yield* container(
            `bayn-kafka-proof-stall-${suffix}`,
            kafkaImage,
            ['--entrypoint', '/usr/bin/python3', '--user', '65532:65532', '--read-only', '--cap-drop', 'ALL'],
            [
              '-u',
              '-c',
              'import socket,time; listener=socket.socket(); listener.bind(("127.0.0.1",19464)); listener.listen(); print("ready",flush=True); connection,address=listener.accept(); time.sleep(10)',
            ],
            `container:${adapter}`,
          ).pipe(Effect.provideService(Scope.Scope, stallScope))
          yield* waitFor(() => docker(['logs', stall]).pipe(Effect.map((text) => text.includes('ready'))))
          const stalledProbe = yield* probe(adapter, 19464).pipe(Effect.result)
          expect(Result.isFailure(stalledProbe)).toBe(true)
          if (Result.isFailure(stalledProbe)) expect(String(stalledProbe.failure)).toContain('(124)')
          yield* Scope.close(stallScope, Exit.succeed(undefined))
          // The actual retryable SHUTTING_DOWN protocol response must reconnect within the liveness budget.
          const priorOpened = openedStreams
          failActiveStreams(1)
          yield* produce([[fixture.key, { ...fixture.notification, signature: 'f'.repeat(64) }]])
          yield* waitFor(() => Effect.sync(() => openedStreams > priorOpened && activeStreams.size === 1))
          const reconnectedMetrics = yield* metrics()
          writeFileSync(`${evidence}-transient-reconnected.prom`, reconnectedMetrics)
          yield* probe(adapter)
          yield* atOffset(1)
          expect(notificationCaptures).toBe(0)
          const terminalAt = Date.now()
          fault = true
          streamFaults += activeStreams.size
          failActiveStreams(4)
          yield* produce([[fixture.key, fixture.notification]])
          yield* waitFor(() =>
            docker(['logs', adapter]).pipe(
              Effect.map(
                (output) => output.includes('permanent ingestion error') && output.includes('ingestion session for'),
              ),
            ),
          )
          const terminalMetrics = yield* metrics()
          writeFileSync(`${evidence}-terminal.prom`, terminalMetrics)
          const terminalOffsets = yield* offsets()
          expect(committed(terminalOffsets)).toBe(1)
          expect(notificationCaptures).toBe(0)
          expect(Result.isFailure(yield* probe(adapter).pipe(Effect.result))).toBe(true)
          fault = false
          yield* Effect.sleep('1500 millis')
          const repairedOffsets = yield* offsets()
          const repairedMetrics = yield* metrics()
          writeFileSync(`${evidence}-repaired.prom`, repairedMetrics)
          const unaidedRecovery = receiptAttempts > 0
          const terminalEvidence = {
            adapterImage,
            protocol: 'SASL_PLAINTEXT',
            mechanism: 'SCRAM-SHA-512',
            streamFaults,
            unaidedRecovery,
            committedBeforeRepair: committed(terminalOffsets),
            committedAfterRepair: committed(repairedOffsets),
            captures,
            receiptAttempts,
            metricsBytes: repairedMetrics.length,
            terminalMetrics: `${evidence}-terminal.prom`,
            repairedMetrics: `${evidence}-repaired.prom`,
          }
          writeFileSync(`${evidence}-terminal.json`, JSON.stringify(terminalEvidence, null, 2))
          process.stdout.write(`BROKER_KAFKA_TERMINAL_EVIDENCE=${JSON.stringify(terminalEvidence)}\n`)
          let livenessFailures = 0
          let automaticRestarts = 0
          // Model kubelet's configured cadence and consecutive-failure budget without an F2 manual restart.
          yield* Effect.gen(function* () {
            while (receiptAttempts === 0 && automaticRestarts === 0) {
              yield* Effect.sleep(`${healthPolicy.periodSeconds} seconds`)
              const result = yield* probe(adapter).pipe(Effect.result)
              livenessFailures = Result.isFailure(result) ? livenessFailures + 1 : 0
              if (livenessFailures >= healthPolicy.failureThreshold) {
                yield* docker(['restart', adapter])
                automaticRestarts++
              }
            }
          }).pipe(Effect.forkScoped({ startImmediately: true }))
          yield* waitFor(
            () => Effect.sync(() => receiptAttempts >= 6),
            (healthPolicy.periodSeconds * healthPolicy.failureThreshold + 20) * 5,
          )
          yield* atOffset(2)
          expect(receipts.size).toBe(0)
          expect(notificationCaptures).toBe(0)
          const pending = yield* json(`${admin}/query`, {
            query: `SELECT id,status FROM sys_invocation WHERE target_service_name='${owner.name}' AND target_handler_name='notify' AND target_service_key='${fixture.key}' AND status <> 'completed'`,
          }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(QuerySchema)))
          expect(pending.rows).toHaveLength(1)
          expect(pending.rows[0]?.status).not.toBe('paused')
          expect(pending.rows[0]?.status).not.toBe('completed')
          receiptBlocked = false
          yield* waitFor(() => Effect.sync(() => notificationCaptures === 1 && receipts.size === 1))
          const canonicalRecoveryMs = Date.now() - terminalAt
          const automaticRecovery = receiptAttempts > 0 && (automaticRestarts === 1 || unaidedRecovery)
          expect(automaticRecovery).toBe(true)
          expect(automaticRestarts).toBe(1)
          expect(livenessFailures).toBe(healthPolicy.failureThreshold)
          yield* probe(adapter)
          expect(invalidations).toBe(1)
          expect([...receipts.values()]).toEqual([true])
          // Pausing the actual core prevents any new durable ingestion while retaining its journal/tmpfs.
          yield* docker(['pause', core])
          yield* Effect.addFinalizer(() => docker(['unpause', core]).pipe(Effect.ignore))
          const second = ready(`second-${suffix}`)
          yield* produce([[fixture.key, second]])
          yield* Effect.sleep('1200 millis')
          expect(committed(yield* offsets())).toBe(2)
          expect(notificationCaptures).toBe(1)
          yield* docker(['unpause', core])
          yield* atOffset(3)
          yield* waitFor(() => Effect.sync(() => notificationCaptures === 2 && receipts.size === 2))
          const foreign = sign({
            ...notification,
            session: { ...notification.session, accountId: '00000000-0000-4000-8000-000000000003' },
          })
          const invalidSource = sign({
            ...notification,
            session: { ...notification.session, sourceRevision: 'not-a-source-revision' },
          })
          yield* produce([
            [fixture.key, foreign],
            [fixture.key, { ...fixture.notification, signature: 'f'.repeat(64) }],
            [fixture.key, invalidSource],
            ['f'.repeat(64), fixture.notification],
          ])
          yield* atOffset(7)
          yield* waitFor(() => Effect.sync(() => verified.filter((entry) => !entry.accepted).length === 4))
          expect(
            verified
              .filter((entry) => !entry.accepted)
              .map((entry) => entry.reason)
              .sort((left, right) => (left ?? '').localeCompare(right ?? '')),
          ).toEqual(['account', 'message', 'signature', 'signature'])
          expect(notificationCaptures).toBe(2)
          const baselineAttempts = receiptAttempts
          yield* produce([
            [fixture.key, fixture.notification],
            [fixture.key, second],
          ])
          yield* atOffset(9)
          yield* waitFor(() => Effect.sync(() => receiptAttempts === baselineAttempts + 2))
          expect(notificationCaptures).toBe(2)
          expect(invalidations).toBe(2)
          // Crash with polled records still unacknowledged by the paused core, then force reassignment.
          yield* docker(['pause', core])
          const third = ready(`third-${suffix}`)
          const consumedCount = (text: string) =>
            Number(/^kafka_consumer_fetch_manager_records_consumed_total\{[^\n]*\} ([\d.]+)$/m.exec(text)?.[1] ?? 'NaN')
          const beforeCrashConsumed = consumedCount(yield* metrics())
          yield* produce([
            [fixture.key, third],
            [fixture.key, fixture.notification],
          ])
          yield* waitFor(() => metrics().pipe(Effect.map((text) => consumedCount(text) >= beforeCrashConsumed + 2)))
          expect(committed(yield* offsets())).toBe(9)
          yield* docker(['kill', '--signal=KILL', adapter])
          const replacement = yield* container(`bayn-kafka-proof-replacement-${suffix}`, adapterImage, adapterArgs)
          const peer = yield* container(`bayn-kafka-proof-peer-${suffix}`, adapterImage, adapterArgs)
          yield* waitFor(() =>
            docker([
              'exec',
              kafka,
              'kafka-consumer-groups',
              ...commandConfig,
              '--group',
              group,
              '--describe',
              '--members',
            ]).pipe(
              Effect.map((output) => output.split('\n').filter((line) => line.trim().startsWith(group)).length === 2),
            ),
          )
          expect(committed(yield* offsets())).toBe(9)
          yield* docker(['unpause', core])
          yield* atOffset(11)
          yield* waitFor(() => Effect.sync(() => notificationCaptures === 3 && receipts.size === 3))
          expect(invalidations).toBe(3)
          expect([...receipts.values()]).toEqual([true, true, true])
          const finalInvocations = yield* json(`${admin}/query`, {
            query: `SELECT id,status FROM sys_invocation WHERE target_service_name='${owner.name}' AND target_handler_name='notify'`,
          }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(QuerySchema)))
          expect(finalInvocations.rows).toHaveLength(11)
          expect(finalInvocations.rows.every((row) => row.status === 'completed')).toBe(true)
          for (const [label, member] of [
            ['replacement', replacement],
            ['peer', peer],
          ] as const) {
            yield* waitFor(() => probe(member).pipe(Effect.result, Effect.map(Result.isSuccess)))
            expect(
              (yield* docker(['exec', member, '/usr/bin/sha256sum', '/opt/bayn/health/probe.sh'])).split(/\s+/)[0],
            ).toBe(healthScriptSha256)
            const metricResponse = yield* response(`http://${yield* docker(['port', member, '9464/tcp'])}/metrics`)
            expect(metricResponse.status).toBe(200)
            writeFileSync(`${evidence}-${label}.prom`, yield* Effect.promise(() => metricResponse.text()))
          }
          // Match the production topic's three partitions without changing the checked source record sequence.
          yield* docker([
            'exec',
            kafka,
            'kafka-topics',
            ...commandConfig,
            '--alter',
            '--topic',
            topic,
            '--partitions',
            '3',
          ])
          const assignedCount = (text: string) =>
            Number(/^kafka_consumer_coordinator_assigned_partitions\{[^\n]*\} ([\d.]+)$/m.exec(text)?.[1] ?? 'NaN')
          yield* waitFor(() =>
            Effect.all([metrics(replacement), metrics(peer)], { concurrency: 2 }).pipe(
              Effect.map((samples) => {
                const counts = samples.map(assignedCount).sort((left, right) => left - right)
                return counts[0] === 1 && counts[1] === 2
              }),
            ),
          )
          for (const [label, member] of [
            ['replacement', replacement],
            ['peer', peer],
          ] as const) {
            yield* waitFor(() => probe(member).pipe(Effect.result, Effect.map(Result.isSuccess)))
            const sample = yield* response(`http://${yield* docker(['port', member, '9464/tcp'])}/metrics`).pipe(
              Effect.flatMap((result) => Effect.promise(() => result.text())),
            )
            writeFileSync(`${evidence}-three-partitions-${label}.prom`, sample)
          }
          yield* docker(['kill', '--signal=KILL', peer])
          const replacementMetricsUrl = `http://${yield* docker(['port', replacement, '9464/tcp'])}/metrics`
          yield* waitFor(() =>
            response(replacementMetricsUrl).pipe(
              Effect.flatMap((result) => Effect.promise(() => result.text())),
              Effect.map((sample) => /^kafka_consumer_coordinator_assigned_partitions\{[^\n]*\} 3\.0$/m.test(sample)),
            ),
          )
          yield* waitFor(() => probe(replacement).pipe(Effect.result, Effect.map(Result.isSuccess)))
          const allPartitions = yield* response(
            `http://${yield* docker(['port', replacement, '9464/tcp'])}/metrics`,
          ).pipe(Effect.flatMap((result) => Effect.promise(() => result.text())))
          writeFileSync(`${evidence}-three-partitions-single-owner.prom`, allPartitions)
          expect(allPartitions).toMatch(/^vertx_http_client_active_requests\{method="POST"\} 3\.0$/m)
          expect(sha256(readFileSync(healthScriptPath, 'utf8'))).toBe(healthScriptSha256)
          const final = {
            ...terminalEvidence,
            receiptAttempts,
            uniqueReceipts: receipts.size,
            captures,
            notificationCaptures,
            completenessCaptures,
            canonicalRecoveryMs,
            livenessFailures,
            automaticRestarts,
            automaticRecovery,
            healthScriptSha256,
            livenessPeriodSeconds: healthPolicy.periodSeconds,
            livenessFailureThreshold: healthPolicy.failureThreshold,
            invalidations,
            committed: committed(yield* offsets()),
            notifyInvocations: finalInvocations.rows.length,
            replacement,
            peer,
            metricsLimit:
              'Synthetic SCRAM credentials; private bootstrap listener; no production ACL/TLS or live financial I/O is exercised',
          }
          writeFileSync(`${evidence}-qualified.json`, JSON.stringify(final, null, 2))
          process.stdout.write(`BROKER_KAFKA_RECOVERY_EVIDENCE=${JSON.stringify(final)}\n`)
          expect(automaticRecovery).toBe(true)
        }),
      ).pipe(Effect.timeout('210 seconds')),
    )
  }, 240_000)
})
