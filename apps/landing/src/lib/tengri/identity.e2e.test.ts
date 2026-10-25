import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as httpServer } from 'node:http'
import { createServer as httpsServer } from 'node:https'
import path from 'node:path'
import { createConnection, createServer as tcpServer, type Socket } from 'node:net'
import { afterAll, expect, mock, test } from 'bun:test'
import { create, toBinary } from '@bufbuild/protobuf'
import AxeBuilder from '@axe-core/playwright'
import { chromium, expect as browserExpect } from '@playwright/test'
import { Pool } from 'pg'
import { z } from 'zod'
import { accessCommandSchema, MAX_ACCESS_COMMAND_BYTES } from './access-schemas'
import { createSpiffeFixture } from './spiffe.fixture'

void mock.module('server-only', () => ({}))
const identityTest = process.env.OFZ_IDENTITY_FIXTURE === '1' ? test : test.skip
const root = path.resolve(import.meta.dir, '../../../../..')
const processes: ReturnType<typeof spawn>[] = []
const cleanups: (() => unknown)[] = []

async function routingEndpoint(port: number, firstBackend: number) {
  let backend = firstBackend
  const connections = new Set<Socket>()
  const service = tcpServer((incoming) => {
    const upstream = createConnection(backend, '127.0.0.1')
    for (const socket of [incoming, upstream]) {
      connections.add(socket)
      socket.once('close', () => connections.delete(socket))
      socket.on('error', () => {
        incoming.destroy()
        upstream.destroy()
      })
    }
    incoming.once('close', () => upstream.destroy())
    upstream.once('close', () => incoming.destroy())
    incoming.pipe(upstream).pipe(incoming)
  })
  service.listen(port, '127.0.0.1')
  await once(service, 'listening')
  const disconnect = () => {
    for (const socket of connections) socket.destroy()
  }
  cleanups.push(() => {
    disconnect()
    return new Promise<void>((resolve) => service.close(() => resolve()))
  })
  return {
    route(nextBackend: number) {
      backend = nextBackend
      disconnect()
    },
  }
}

afterAll(async () => {
  await Promise.all(
    processes.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      const deadline = setTimeout(() => child.kill('SIGKILL'), 5000)
      try {
        await once(child, 'exit')
      } finally {
        clearTimeout(deadline)
      }
    }),
  )
  for (const cleanup of cleanups.reverse()) await cleanup()
}, 15_000)

identityTest(
  'real browser, GitHub broker, passkey, BFF, SPIFFE Ofz and shared SQL sessions',
  async () => {
    const fixture = await createSpiffeFixture()
    cleanups.push(() => fixture.close())
    const ofz = fixture.certificate('ofz', 'spiffe://proompteng.ai/ns/ofz/sa/ofz-api')
    fixture.include(ofz.svid, fixture.peer.svid)
    const settings = { ...process.env }
    cleanups.push(() => {
      for (const key of Object.keys(process.env)) if (!(key in settings)) delete process.env[key]
      Object.assign(process.env, settings)
    })
    const port = Number(
      z
        .string()
        .regex(/port=([0-9]+)/)
        .parse(process.env.OFZ_TEST_DSN)
        .match(/port=([0-9]+)/)?.[1],
    )
    const ca = readFileSync(z.string().parse(process.env.OFZ_TEST_CA_FILE), 'utf8')
    const admin = new Pool({
      host: 'localhost',
      port,
      user: 'postgres',
      database: 'postgres',
      ssl: { ca, rejectUnauthorized: true, servername: 'localhost' },
      max: 2,
    })
    cleanups.push(() => admin.end())
    await admin.query(
      "CREATE ROLE ofz_api LOGIN PASSWORD 'fixture-api'; CREATE ROLE ofz_archiver NOLOGIN; CREATE ROLE tengri_bff LOGIN PASSWORD 'fixture-bff'; CREATE ROLE tengri_controller LOGIN PASSWORD 'fixture-controller'; CREATE ROLE tengri_supervisor NOLOGIN; CREATE ROLE tengri_migrator LOGIN PASSWORD 'fixture-migrator';",
    )
    await admin.query('CREATE DATABASE tengri_control OWNER tengri_migrator')
    await admin.query('CREATE DATABASE keycloak')
    const control = new Pool({
      host: 'localhost',
      port,
      user: 'postgres',
      database: 'ofz_control',
      ssl: { ca, rejectUnauthorized: true, servername: 'localhost' },
      max: 2,
    })
    cleanups.push(() => control.end())
    const bffAdmin = new Pool({
      host: 'localhost',
      port,
      user: 'postgres',
      database: 'tengri_control',
      ssl: { ca, rejectUnauthorized: true, servername: 'localhost' },
      max: 2,
    })
    cleanups.push(() => bffAdmin.end())
    const migration = readFileSync(path.join(root, 'services/tengri/migrations/0001_control.sql'))
    const replayMigration = readFileSync(path.join(root, 'services/tengri/migrations/0002_replay_buckets.sql'))
    const replaySlotsMigration = readFileSync(path.join(root, 'services/tengri/migrations/0003_replay_slots.sql'))
    const leadershipMigration = readFileSync(path.join(root, 'services/tengri/migrations/0004_leadership_window.sql'))
    const capabilityMigration = readFileSync(path.join(root, 'services/tengri/migrations/0005_capability_slots.sql'))
    const leaseMigration = readFileSync(path.join(root, 'services/tengri/migrations/0006_preview_lease_identity.sql'))
    const oauthMigration = readFileSync(path.join(root, 'services/tengri/migrations/0007_ephemeral_oauth.sql'))
    const secret = (name: string, value: string) => {
      const file = path.join(fixture.directory, name)
      writeFileSync(file, value, { mode: 0o600 })
      return file
    }
    const apiPassword = secret('api-password', 'fixture-api')
    const emptyPassword = secret('owner-password', '')
    const binary = path.join(root, 'services/ofz/target/debug/ofz')
    const common = {
      ...process.env,
      OFZ_DATABASE_DSN: `host=localhost port=${port} dbname=ofz_control user=postgres sslmode=require`,
      OFZ_DATABASE_PASSWORD_FILE: emptyPassword,
      OFZ_DATABASE_CA_FILE: process.env.OFZ_TEST_CA_FILE || '',
    }
    execFileSync(binary, ['migrate'], { env: common, stdio: 'pipe' })
    const runtimeMigration = {
      ...common,
      OFZ_DATABASE_DSN: `host=localhost port=${port} dbname=tengri_control user=tengri_migrator sslmode=require`,
      OFZ_DATABASE_PASSWORD_FILE: secret('runtime-owner-password', 'fixture-migrator'),
    }
    const expectedChecksum = createHash('sha256').update(migration).digest()
    const replayChecksum = createHash('sha256').update(replayMigration).digest()
    const replaySlotsChecksum = createHash('sha256').update(replaySlotsMigration).digest()
    const leadershipChecksum = createHash('sha256').update(leadershipMigration).digest()
    const capabilityChecksum = createHash('sha256').update(capabilityMigration).digest()
    const leaseChecksum = createHash('sha256').update(leaseMigration).digest()
    const oauthChecksum = createHash('sha256').update(oauthMigration).digest()
    await bffAdmin.query('SET ROLE tengri_migrator')
    await bffAdmin.query(migration.toString())
    await bffAdmin.query('INSERT INTO tengri.schema_version(version,checksum) VALUES(1,$1)', [expectedChecksum])
    await bffAdmin.query(replayMigration.toString())
    await bffAdmin.query('INSERT INTO tengri.schema_version(version,checksum) VALUES(2,$1)', [replayChecksum])
    const retainedWorkspace = randomUUID()
    const retainedTicket = Buffer.alloc(32, 31)
    await bffAdmin.query(
      "INSERT INTO tengri.tickets(token_hash,agent_id,workspace_uid,payload,expires_at_ms) VALUES($1,'retained',$2,'{}',tengri.now_ms()+30000)",
      [retainedTicket, retainedWorkspace],
    )
    await bffAdmin.query(
      "INSERT INTO tengri.previews(id,token_hash,revocation_hash,agent_id,workspace_uid,payload,expires_at_ms) VALUES('abcdefghijklmnopqrstuvwx',$1,$1,'retained',$2,'{}',tengri.now_ms()+30000)",
      [retainedTicket, retainedWorkspace],
    )
    const retainedNonce = Buffer.alloc(32, 47)
    expect(
      (await bffAdmin.query('SELECT tengri.consume_nonce($1,tengri.now_ms()+6000) AS consumed', [retainedNonce]))
        .rows[0]?.consumed,
    ).toBe(true)
    const retainedOAuthState = Buffer.alloc(32, 51)
    const retainedOAuthOperation = randomUUID()
    await bffAdmin.query('SELECT tengri.begin_oauth($1,$2,$3,$4,$5)', [
      retainedOAuthState,
      Buffer.alloc(32, 52),
      'v'.repeat(43),
      'n'.repeat(43),
      retainedOAuthOperation,
    ])
    await bffAdmin.query('RESET ROLE')
    for (let attempt = 0; attempt < 2; attempt++) {
      execFileSync(binary, ['migrate-runtime'], { env: runtimeMigration, stdio: 'pipe' })
    }
    const versions = await bffAdmin.query<{ version: number; checksum: Buffer }>(
      'SELECT version,checksum FROM tengri.schema_version ORDER BY version',
    )
    expect(versions.rowCount).toBe(7)
    expect(versions.rows[0]?.version).toBe(1)
    expect(versions.rows[0]?.checksum.equals(expectedChecksum)).toBe(true)
    expect(versions.rows[1]?.version).toBe(2)
    expect(versions.rows[1]?.checksum.equals(replayChecksum)).toBe(true)
    expect(versions.rows[2]?.version).toBe(3)
    expect(versions.rows[2]?.checksum.equals(replaySlotsChecksum)).toBe(true)
    expect(versions.rows[3]?.version).toBe(4)
    expect(versions.rows[3]?.checksum.equals(leadershipChecksum)).toBe(true)
    expect(versions.rows[4]?.version).toBe(5)
    expect(versions.rows[4]?.checksum.equals(capabilityChecksum)).toBe(true)
    expect(versions.rows[5]?.version).toBe(6)
    expect(versions.rows[5]?.checksum.equals(leaseChecksum)).toBe(true)
    expect(versions.rows[6]?.version).toBe(7)
    expect(versions.rows[6]?.checksum.equals(oauthChecksum)).toBe(true)
    expect(
      (await bffAdmin.query('SELECT operation_id FROM tengri.oauth_attempts WHERE state_hash=$1', [retainedOAuthState]))
        .rows,
    ).toEqual([{ operation_id: retainedOAuthOperation }])
    await bffAdmin.query('DELETE FROM tengri.oauth_attempts WHERE state_hash=$1', [retainedOAuthState])
    expect(
      (
        await bffAdmin.query<{ relname: string; relpersistence: string }>(
          "SELECT relname,relpersistence FROM pg_class WHERE relnamespace='tengri'::regnamespace AND relkind='r' ORDER BY relname",
        )
      ).rows.filter((row) => row.relpersistence !== 'p'),
    ).toEqual([{ relname: 'oauth_attempts', relpersistence: 'u' }])
    const migratedLease = await bffAdmin.query(
      "SELECT payload->>'lease_id' AS id FROM tengri.previews WHERE workspace_uid=$1",
      [retainedWorkspace],
    )
    expect(z.uuid().safeParse(migratedLease.rows[0]?.id).success).toBe(true)
    for (const table of ['tickets', 'previews']) {
      const retained = await bffAdmin.query<{ capacity_slot: number; workspace_slot: number }>(
        `SELECT capacity_slot,workspace_slot FROM tengri.${table} WHERE workspace_uid=$1`,
        [retainedWorkspace],
      )
      expect(retained.rows).toEqual([{ capacity_slot: 1, workspace_slot: 1 }])
      await bffAdmin.query(`DELETE FROM tengri.${table} WHERE workspace_uid=$1`, [retainedWorkspace])
    }
    expect(
      (await bffAdmin.query('SELECT tengri.consume_nonce($1,tengri.now_ms()+5000) AS consumed', [retainedNonce]))
        .rows[0]?.consumed,
    ).toBe(false)
    expect((await bffAdmin.query('SELECT count(*)::int AS slots FROM tengri.replay_nonces')).rows[0]?.slots).toBe(8192)
    expect(() =>
      execFileSync(binary, ['migrate-runtime'], {
        env: {
          ...common,
          OFZ_DATABASE_DSN: `host=localhost port=${port} dbname=tengri_control user=postgres sslmode=require`,
        },
        stdio: 'pipe',
      }),
    ).toThrow()
    await bffAdmin.query('UPDATE tengri.schema_version SET checksum=$1 WHERE version=2', [Buffer.alloc(32)])
    expect(() => execFileSync(binary, ['migrate-runtime'], { env: runtimeMigration, stdio: 'pipe' })).toThrow()
    await bffAdmin.query('UPDATE tengri.schema_version SET checksum=$1 WHERE version=2', [replayChecksum])
    await bffAdmin.query('UPDATE tengri.schema_version SET checksum=$1 WHERE version=3', [Buffer.alloc(32)])
    expect(() => execFileSync(binary, ['migrate-runtime'], { env: runtimeMigration, stdio: 'pipe' })).toThrow()
    await bffAdmin.query('UPDATE tengri.schema_version SET checksum=$1 WHERE version=3', [replaySlotsChecksum])
    await bffAdmin.query('UPDATE tengri.schema_version SET checksum=$1 WHERE version=4', [Buffer.alloc(32)])
    expect(() => execFileSync(binary, ['migrate-runtime'], { env: runtimeMigration, stdio: 'pipe' })).toThrow()
    await bffAdmin.query('UPDATE tengri.schema_version SET checksum=$1 WHERE version=4', [leadershipChecksum])
    await bffAdmin.query('UPDATE tengri.schema_version SET checksum=$1 WHERE version=5', [Buffer.alloc(32)])
    expect(() => execFileSync(binary, ['migrate-runtime'], { env: runtimeMigration, stdio: 'pipe' })).toThrow()
    await bffAdmin.query('UPDATE tengri.schema_version SET checksum=$1 WHERE version=5', [capabilityChecksum])
    await bffAdmin.query('UPDATE tengri.schema_version SET checksum=$1 WHERE version=6', [Buffer.alloc(32)])
    expect(() => execFileSync(binary, ['migrate-runtime'], { env: runtimeMigration, stdio: 'pipe' })).toThrow()
    await bffAdmin.query('UPDATE tengri.schema_version SET checksum=$1 WHERE version=6', [leaseChecksum])
    await bffAdmin.query('UPDATE tengri.schema_version SET checksum=$1 WHERE version=7', [Buffer.alloc(32)])
    expect(() => execFileSync(binary, ['migrate-runtime'], { env: runtimeMigration, stdio: 'pipe' })).toThrow()
    await bffAdmin.query('UPDATE tengri.schema_version SET checksum=$1 WHERE version=7', [oauthChecksum])
    const native = z.string().url().parse(process.env.OFZ_TEST_NATIVE_ENDPOINT)
    const nativeCall = async (endpoint: string, body: unknown) => {
      const response = await fetch(native + endpoint, {
        method: 'POST',
        headers: { Authorization: 'Bearer ofz-policy-fixture', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error(`Fixture native setup failed ${response.status}`)
      return response
    }
    await nativeCall('/v1/schema/write', { schema: readFileSync(path.join(root, 'services/ofz/schema.zed'), 'utf8') })
    const humans = ['1', '2'].map((githubId) => ({
      githubId,
      humanId: createHash('sha256').update(`github:${githubId}`).digest('hex'),
    }))
    const updates = []
    const relation = (kind: string, id: string, role: string, subjectKind: string, subjectId: string) => ({
      operation: 'OPERATION_TOUCH',
      relationship: {
        resource: { objectType: kind, objectId: id },
        relation: role,
        subject: { object: { objectType: subjectKind, objectId: subjectId } },
      },
    })
    for (const human of humans) {
      await control.query('INSERT INTO ofz.humans VALUES($1,$2)', [human.humanId, human.githubId])
      await control.query('INSERT INTO ofz.memberships(human_id,role) VALUES($1,1),($1,2)', [human.humanId])
      updates.push(
        relation('platform', 'lab', 'member', 'human', human.humanId),
        relation('platform', 'lab', 'administrator', 'human', human.humanId),
      )
    }
    for (const [role, id] of [
      ['bff', fixture.ownId],
      ['controller', fixture.peerId],
    ])
      updates.push(relation('platform', 'lab', role, 'workload', createHash('sha256').update(id).digest('hex')))
    updates.push(relation('policy_version', 'lab', 'current', 'workload', 'version_1'))
    await nativeCall('/v1/relationships/write', { updates })
    await control.query('UPDATE ofz.platform_state SET version=1,fenced=false')
    // Synthetic acknowledgements keep identity scenarios independent of the archive-loss gate.
    const acknowledgeFixtureArchive = () =>
      control.query(
        "BEGIN; UPDATE ofz.audit_outbox SET acknowledged_at_ms=ofz.now_ms(),archive_receipt='identity-fixture-only'; UPDATE ofz.archive_state SET acknowledged_sequence=coalesce((SELECT max(sequence) FROM ofz.audit),0),acknowledged_at_ms=ofz.now_ms(); COMMIT;",
      )
    const heartbeat = setInterval(() => {
      void acknowledgeFixtureArchive().catch((cause: unknown) => {
        throw new Error('Synthetic identity archive acknowledgement failed', { cause })
      })
    }, 1000)
    cleanups.push(() => clearInterval(heartbeat))
    await acknowledgeFixtureArchive()
    const codes = new Map<string, string>(),
      tokens = new Map<string, string>()
    let githubSecret = 'fixture-github-secret'
    const github = httpServer(async (request, response) => {
      const url = new URL(request.url || '/', 'http://localhost')
      if (url.pathname === '/login/oauth/authorize') {
        const redirect = z.string().parse(url.searchParams.get('redirect_uri')),
          state = z.string().parse(url.searchParams.get('state'))
        response.setHeader('Content-Type', 'text/html')
        response.end(
          ['1', '2', '3', '999']
            .map((id) => {
              const code = randomUUID()
              codes.set(code, id)
              const callback = new URL(redirect)
              callback.search = new URLSearchParams({ code, state }).toString()
              return `<p><a href="${callback.href.replaceAll('&', '&amp;')}">GitHub fixture ${id}</a></p>`
            })
            .join(''),
        )
        return
      }
      if (url.pathname === '/login/oauth/access_token') {
        const bytes = []
        for await (const chunk of request) bytes.push(Buffer.from(chunk))
        const body = new URLSearchParams(Buffer.concat(bytes).toString()),
          code = body.get('code') || '',
          id = codes.get(code)
        const basic = (request.headers.authorization || '').startsWith('Basic ')
          ? Buffer.from((request.headers.authorization || '').slice(6), 'base64')
              .toString()
              .split(':')
          : []
        if (
          (body.get('client_id') || basic[0]) !== 'fixture-github' ||
          (body.get('client_secret') || basic[1]) !== githubSecret
        ) {
          response.writeHead(401).end()
          return
        }
        codes.delete(code)
        if (!id) {
          response.writeHead(400).end()
          return
        }
        const token = randomUUID()
        tokens.set(token, id)
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ access_token: token, token_type: 'bearer', scope: 'read:user user:email' }))
        return
      }
      const id = tokens.get((request.headers.authorization || '').replace(/^Bearer /i, ''))
      if (!id) {
        response.writeHead(401).end()
        return
      }
      response.setHeader('Content-Type', 'application/json')
      response.end(
        JSON.stringify(
          url.pathname === '/user/emails'
            ? [{ email: 'same@fixture.invalid', primary: true, verified: true }]
            : {
                id: Number(id),
                login: `fixture-${id}`,
                name: 'Fixture User',
                email: 'same@fixture.invalid',
                avatar_url: '',
              },
        ),
      )
    })
    github.listen(0, '127.0.0.1')
    await once(github, 'listening')
    cleanups.push(() => new Promise<void>((resolve) => github.close(() => resolve())))
    const githubAddress = github.address()
    if (!githubAddress || typeof githubAddress === 'string') throw new Error('Fixture GitHub port missing')
    const certPath = secret('issuer.pem', ''),
      keyPath = secret('issuer.key', '')
    execFileSync(
      'openssl',
      [
        'req',
        '-new',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-subj',
        '/CN=auth.proompteng.ai',
        '-keyout',
        keyPath,
        '-out',
        path.join(fixture.directory, 'issuer.csr'),
      ],
      { stdio: 'ignore' },
    )
    const extension = secret(
      'issuer.ext',
      'basicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:auth.proompteng.ai,DNS:proompteng.ai\n',
    )
    execFileSync(
      'openssl',
      [
        'x509',
        '-req',
        '-in',
        path.join(fixture.directory, 'issuer.csr'),
        '-CA',
        path.join(fixture.directory, 'ca.pem'),
        '-CAkey',
        path.join(fixture.directory, 'ca.key'),
        '-CAcreateserial',
        '-days',
        '1',
        '-sha256',
        '-extfile',
        extension,
        '-out',
        certPath,
      ],
      { stdio: 'ignore' },
    )
    // The HTTPS adapter executes the actual route functions. Only HTML and GitHub are fixtures.
    const { ofzCall: realOfzCall, OfzError, isOfzConfigured } = await import('./ofz')
    let loseEstablishmentReply = true
    let loseCommandReply = false
    const establishmentAttempts: string[] = []
    const withReplyLoss: typeof realOfzCall = async (method, input, signal) => {
      if (method.localName === 'establishSession') {
        establishmentAttempts.push(
          createHash('sha256')
            .update(toBinary(method.input, create(method.input, input)))
            .digest('hex'),
        )
      }
      const result = await realOfzCall(method, input, signal)
      if (method.localName === 'executeCommand' && loseCommandReply) {
        loseCommandReply = false
        throw new OfzError(503)
      }
      if (method.localName === 'establishSession' && loseEstablishmentReply) {
        loseEstablishmentReply = false
        throw new OfzError(503)
      }
      return result
    }
    // Simulate one lost reply after the real Ofz transaction and RPC have succeeded.
    void mock.module('./ofz', () => ({ ofzCall: withReplyLoss, OfzError, isOfzConfigured }))
    const { getTengriIdentity } = await import('./auth')
    const authRoute = await import('@/app/api/auth/[...all]/route')
    const { verifyGithubIdentity } = await import('./github-identity')
    let identityLookups = 0
    void mock.module('./github-identity', () => ({
      resolveGithubIdentity: async (login: string) => {
        identityLookups++
        const id = z
          .string()
          .regex(/^fixture-(1|2|3|999)$/)
          .parse(login)
          .slice('fixture-'.length)
        return verifyGithubIdentity(login, { id: Number(id), login, type: 'User' })
      },
    }))
    const access = await import('@/app/api/tengri/access/route')
    const bundle = await Bun.build({
      entrypoints: [path.join(import.meta.dir, 'identity-browser.fixture.tsx')],
      target: 'browser',
      minify: true,
    })
    if (!bundle.success) throw new Error('Identity browser fixture bundle failed')
    const javascript = await bundle.outputs[0]?.text()
    const bff = httpsServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, async (request, response) => {
      try {
        const url = new URL(request.url || '/', process.env.TENGRI_DESKTOP_ORIGIN)
        if (url.pathname === '/') {
          response.setHeader('Content-Type', 'text/html; charset=utf-8')
          response.end(
            '<!doctype html><html><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
          )
          return
        }
        if (url.pathname === '/fixture.js') {
          response.setHeader('Content-Type', 'text/javascript; charset=utf-8')
          response.end(javascript)
          return
        }
        const headers = new Headers()
        for (const [name, value] of Object.entries(request.headers))
          if (value) headers.set(name, Array.isArray(value) ? value.join(',') : value)
        const chunks = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const incoming = new Request(new URL(url.pathname + url.search, 'http://0.0.0.0:3000'), {
          method: request.method,
          headers,
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        })
        let outgoing: Response
        if (url.pathname === '/fixture/session')
          outgoing = new Response(null, { status: (await getTengriIdentity(headers)) ? 204 : 401 })
        else if (url.pathname.startsWith('/api/auth/')) {
          outgoing =
            request.method === 'GET'
              ? await authRoute.GET(incoming)
              : request.method === 'POST'
                ? await authRoute.POST(incoming)
                : request.method === 'HEAD'
                  ? authRoute.HEAD()
                  : authRoute.OPTIONS()
        } else if (url.pathname === '/api/tengri/access')
          outgoing = await (request.method === 'GET' ? access.GET : access.POST)(incoming)
        else outgoing = new Response(null, { status: 404 })
        response.statusCode = outgoing.status
        for (const [name, value] of outgoing.headers) if (name !== 'set-cookie') response.setHeader(name, value)
        for (const value of outgoing.headers.getSetCookie()) response.appendHeader('Set-Cookie', value)
        response.end(Buffer.from(await outgoing.arrayBuffer()))
      } catch {
        response.writeHead(503).end('Fixture request failed')
      }
    })
    bff.listen(0, '127.0.0.1')
    await once(bff, 'listening')
    cleanups.push(() => new Promise<void>((resolve) => bff.close(() => resolve())))
    const bffAddress = bff.address()
    if (!bffAddress || typeof bffAddress === 'string') throw new Error('Fixture BFF port missing')
    const freePort = async () => {
      const server = httpServer()
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Fixture port missing')
      await new Promise<void>((resolve) => server.close(() => resolve()))
      return address.port
    }
    const kcHttp = await freePort(),
      kcHttps = await freePort(),
      ofzPort = await freePort()
    const kcPrimaryHttps = await freePort(),
      kcSecondaryHttp = await freePort(),
      kcSecondaryHttps = await freePort()
    const base = `https://proompteng.ai:${bffAddress.port}`,
      issuer = `https://auth.proompteng.ai:${kcHttps}/realms/tengri`
    Object.assign(process.env, {
      TENGRI_DESKTOP_ORIGIN: base,
      TENGRI_OIDC_ISSUER: issuer,
      TENGRI_OIDC_CLIENT_SECRET_FILE: secret('oidc-secret', 'fixture-bff-secret-not-production-0000000'),
      TENGRI_OIDC_CONNECT_IP: '127.0.0.1',
      TENGRI_OIDC_CA_FILE: path.join(fixture.directory, 'ca.pem'),
      TENGRI_DATABASE_DSN: `postgres://tengri_bff@localhost:${port}/tengri_control`,
      TENGRI_DATABASE_PASSWORD_FILE: secret('bff-password', 'fixture-bff'),
      TENGRI_DATABASE_CA_FILE: process.env.OFZ_TEST_CA_FILE,
      OFZ_GRPC_ENDPOINT: `localhost:${ofzPort}`,
      SPIFFE_ID: fixture.ownId,
      SPIFFE_ENDPOINT_SOCKET: fixture.endpoint,
      SPIFFE_WORKLOAD_API_PROTO_PATH: fixture.protoPath,
    })
    expect((await admin.query('SHOW synchronous_standby_names')).rows[0]?.synchronous_standby_names).toBe('')
    await admin.query("ALTER SYSTEM SET synchronous_standby_names='ANY 1 (oauth_fixture_missing)'")
    try {
      await admin.query('SELECT pg_reload_conf()')
      for (let attempt = 0; ; attempt++) {
        const setting = (await admin.query('SHOW synchronous_standby_names')).rows[0]?.synchronous_standby_names
        if (setting === 'ANY 1 (oauth_fixture_missing)') break
        if (attempt === 100) throw new Error('Fixture synchronous standby setting did not reload')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const started = performance.now()
      const response = await authRoute.POST(
        new Request(`${base}/api/auth/login`, {
          method: 'POST',
          headers: { host: new URL(base).host, origin: base, 'sec-fetch-site': 'same-origin' },
        }),
      )
      expect(response.status).toBe(200)
      expect(performance.now() - started).toBeLessThan(1500)
      const url = new URL(z.object({ url: z.string().url() }).parse(await response.json()).url)
      const state = z.string().length(43).parse(url.searchParams.get('state'))
      const binding = z
        .string()
        .length(43)
        .parse(response.headers.getSetCookie()[0]?.match(/^__Host-tengri-oauth=([^;]+);/)?.[1])
      const { controlDatabase, hashOpaque } = await import('./control-db')
      const database = await controlDatabase()
      const remaining = await bffAdmin.query<{ remaining: string }>(
        'SELECT expires_at_ms-tengri.now_ms() AS remaining FROM tengri.oauth_attempts WHERE state_hash=$1',
        [hashOpaque(state)],
      )
      expect(Number(remaining.rows[0]?.remaining)).toBeGreaterThan(0)
      expect(Number(remaining.rows[0]?.remaining)).toBeLessThanOrEqual(300000)
      const consume = () =>
        database.query(
          'DELETE FROM tengri.oauth_attempts WHERE state_hash=$1 AND binding_hash=$2 AND expires_at_ms>tengri.now_ms() RETURNING operation_id',
          [hashOpaque(state), hashOpaque(binding)],
        )
      const consuming = performance.now()
      expect((await Promise.all([consume(), consume()])).map((result) => result.rowCount).sort()).toEqual([0, 1])
      expect(performance.now() - consuming).toBeLessThan(1500)
      const replay = await authRoute.GET(
        new Request(`${base}/api/auth/callback?state=${state}&code=discarded-attempt`, {
          headers: { host: new URL(base).host, cookie: `__Host-tengri-oauth=${binding}` },
        }),
      )
      expect(replay.status).toBe(401)
      expect(replay.headers.getSetCookie().some((value) => value.startsWith('__Host-tengri-session='))).toBe(false)
    } finally {
      await admin.query('ALTER SYSTEM RESET synchronous_standby_names')
      await admin.query('SELECT pg_reload_conf()')
    }
    const freeCachePort = async () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const candidate = 10000 + Math.floor(Math.random() * 5000)
        const sockets = [tcpServer(), tcpServer()]
        try {
          for (const [index, socket] of sockets.entries()) {
            socket.listen(candidate + index * 50000, '127.0.0.1')
            await once(socket, 'listening')
          }
          return candidate
        } catch {
        } finally {
          await Promise.all(
            sockets
              .filter((socket) => socket.listening)
              .map((socket) => new Promise<void>((resolve) => socket.close(() => resolve()))),
          )
        }
      }
      throw new Error('No isolated Keycloak transport and failure-detection port pair')
    }
    const primaryHome = path.join(fixture.directory, 'keycloak-primary')
    const secondaryHome = path.join(fixture.directory, 'keycloak-secondary')
    cpSync(path.dirname(path.dirname(z.string().parse(process.env.KEYCLOAK_FIXTURE_BIN))), primaryHome, {
      recursive: true,
    })
    cpSync(path.join(root, 'argocd/applications/keycloak/tengri/theme'), path.join(primaryHome, 'themes/tengri'), {
      recursive: true,
    })
    const startKeycloak = async (
      home: string,
      name: string,
      httpPort: number,
      httpsPort: number,
      optimized: boolean,
    ) => {
      const log = secret(`keycloak-${name}.log`, '')
      const server = spawn(
        path.join(home, 'bin/kc.sh'),
        [
          'start',
          ...(optimized ? ['--optimized'] : ['--db=postgres', '--health-enabled=true']),
          '--cache=ispn',
          '--cache-stack=jdbc-ping',
          '--cache-embedded-mtls-enabled=true',
          '--cache-embedded-network-bind-address=127.0.0.1',
          `--cache-embedded-network-bind-port=${await freeCachePort()}`,
          `--spi-cache-embedded--default--node-name=${name}`,
          `--db-url=jdbc:postgresql://localhost:${port}/keycloak?sslmode=verify-full&sslrootcert=${process.env.OFZ_TEST_CA_FILE}`,
          '--db-username=postgres',
          '--db-pool-max-size=20',
          '--http-enabled=true',
          '--http-host=127.0.0.1',
          `--http-port=${httpPort}`,
          `--https-port=${httpsPort}`,
          `--http-management-port=${await freePort()}`,
          `--hostname=https://auth.proompteng.ai:${kcHttps}`,
          `--https-certificate-file=${certPath}`,
          `--https-certificate-key-file=${keyPath}`,
        ],
        {
          env: {
            ...process.env,
            KC_BOOTSTRAP_ADMIN_USERNAME: 'fixture-admin',
            KC_BOOTSTRAP_ADMIN_PASSWORD: 'fixture-only-password',
            JAVA_OPTS_APPEND: '-Xms128m -Xmx768m',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      processes.push(server)
      server.stdout?.on('data', (chunk) => writeFileSync(log, chunk, { flag: 'a' }))
      server.stderr?.on('data', (chunk) => writeFileSync(log, chunk, { flag: 'a' }))
      const startupDeadline = Date.now() + 120_000
      for (;;) {
        if (server.exitCode !== null || server.signalCode !== null || Date.now() >= startupDeadline)
          throw new Error(`Fixture Keycloak ${name} startup failed: ${readFileSync(log, 'utf8').slice(-3000)}`)
        try {
          if ((await fetch(`http://127.0.0.1:${httpPort}/realms/master/.well-known/openid-configuration`)).ok) break
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      return { server, log }
    }
    const kc = await startKeycloak(primaryHome, 'primary', kcHttp, kcPrimaryHttps, false)
    cpSync(primaryHome, secondaryHome, { recursive: true })
    const kcSecondary = await startKeycloak(secondaryHome, 'secondary', kcSecondaryHttp, kcSecondaryHttps, true)
    for (let attempt = 0; ; attempt++) {
      if (
        [kc.log, kcSecondary.log].every((log) =>
          /ISPN000094: Received new cluster view.*\(2\)/.test(readFileSync(log, 'utf8')),
        )
      )
        break
      if (attempt > 100) throw new Error('Production Keycloak instances did not form a two-member jdbc-ping cluster')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const keycloakEndpoint = await routingEndpoint(kcHttps, kcPrimaryHttps)
    let adminBase = `http://127.0.0.1:${kcHttp}`
    const bootstrap = (providerSecret: string, clientSecret: string) =>
      execFileSync('python3', [path.join(root, 'argocd/applications/keycloak/tengri/bootstrap.py')], {
        env: {
          ...process.env,
          KEYCLOAK_ADMIN_URL: adminBase,
          KEYCLOAK_ADMIN_USERNAME: 'fixture-admin',
          KEYCLOAK_ADMIN_PASSWORD: 'fixture-only-password',
          GITHUB_CLIENT_ID: 'fixture-github',
          GITHUB_CLIENT_SECRET: providerSecret,
          TENGRI_OIDC_CLIENT_SECRET: clientSecret,
        },
        stdio: 'pipe',
      })
    bootstrap(githubSecret, 'fixture-bff-secret-not-production-0000000')
    const adminCall = async (endpoint: string, method = 'GET', body?: unknown) => {
      const tokenResponse = await fetch(adminBase + '/realms/master/protocol/openid-connect/token', {
        method: 'POST',
        body: new URLSearchParams({
          client_id: 'admin-cli',
          grant_type: 'password',
          username: 'fixture-admin',
          password: 'fixture-only-password',
        }),
      })
      if (!tokenResponse.ok) throw new Error(`Fixture administrator authentication ${tokenResponse.status}`)
      const token = z.object({ access_token: z.string() }).parse(await tokenResponse.json()).access_token
      const response = await fetch(adminBase + '/admin/realms/tengri' + endpoint, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      if (!response.ok) throw new Error(`Fixture Keycloak setup ${response.status} ${endpoint}`)
      return response
    }
    const provider = z
      .object({ config: z.record(z.string(), z.string()) })
      .passthrough()
      .parse(await (await adminCall('/identity-provider/instances/github')).json())
    provider.config = {
      ...provider.config,
      baseUrl: `http://127.0.0.1:${githubAddress.port}`,
      apiUrl: `http://127.0.0.1:${githubAddress.port}`,
      githubJsonFormat: 'true',
    }
    await adminCall('/identity-provider/instances/github', 'PUT', provider)
    const clients = z
      .array(z.object({ id: z.string() }).passthrough())
      .parse(await (await adminCall('/clients?clientId=tengri-bff')).json())
    const client = clients[0]
    if (!client) throw new Error('Fixture client missing')
    await adminCall(`/clients/${client.id}`, 'PUT', {
      ...client,
      redirectUris: [base + '/api/auth/callback'],
      webOrigins: [base],
    })
    let apiLogs = ''
    const startApi = async (listenPort: number) => {
      const api = spawn(binary, ['serve'], {
        env: {
          ...common,
          RUST_LOG: 'ofz=debug',
          OFZ_DATABASE_DSN: `host=localhost port=${port} dbname=ofz_control user=ofz_api sslmode=require`,
          OFZ_DATABASE_PASSWORD_FILE: apiPassword,
          OFZ_SPICEDB_ENDPOINT: native,
          OFZ_SPICEDB_KEY_FILE: process.env.OFZ_TEST_NATIVE_KEY_FILE,
          OFZ_OIDC_ISSUER: issuer,
          OFZ_OIDC_CLIENT_ID: 'tengri-bff',
          OFZ_OIDC_CONNECT_IP: '127.0.0.1',
          OFZ_OIDC_CA_FILE: path.join(fixture.directory, 'ca.pem'),
          OFZ_LISTEN: `127.0.0.1:${listenPort}`,
          SPIFFE_ENDPOINT_SOCKET: fixture.endpoint,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      processes.push(api)
      let replicaLogs = ''
      api.stdout?.on('data', (chunk) => {
        replicaLogs = (replicaLogs + String(chunk)).slice(-16000)
        apiLogs = (apiLogs + String(chunk)).slice(-16000)
      })
      api.stderr?.on('data', (chunk) => {
        replicaLogs = (replicaLogs + String(chunk)).slice(-16000)
        apiLogs = (apiLogs + String(chunk)).slice(-16000)
      })
      for (let attempt = 0; !replicaLogs.includes('Ofz authorization API listening'); attempt++) {
        if (api.exitCode !== null || attempt > 350)
          throw new Error('Fixture Ofz startup failed: ' + apiLogs.slice(-2000))
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return api
    }
    const firstApiPort = await freePort()
    const secondApiPort = await freePort()
    const firstApi = await startApi(firstApiPort)
    await startApi(secondApiPort)
    const apiEndpoint = await routingEndpoint(ofzPort, firstApiPort)
    const { ofzCall } = await import('./ofz')
    const { AuthorizationService } = await import('./generated/proompteng/authz/v1/authz_pb')
    await ofzCall(AuthorizationService.method.getPolicyState, {}).catch((error) => {
      throw new Error('Ofz wire handshake failed', { cause: error.cause || error })
    })
    const browser = await chromium.launch({
      headless: true,
      args: [
        '--host-resolver-rules=MAP proompteng.ai 127.0.0.1, MAP auth.proompteng.ai 127.0.0.1',
        '--no-proxy-server',
      ],
    })
    cleanups.push(() => browser.close())
    const context = await browser.newContext({ ignoreHTTPSErrors: true })
    const webAuthnRequests: unknown[] = []
    const registrations: unknown[] = []
    await context.exposeFunction('recordRegistrationOptions', (options: unknown) => registrations.push(options))
    await context.exposeFunction('recordWebAuthnOptions', (options: unknown) => {
      webAuthnRequests.push(options)
    })
    const observeWebAuthn = () => {
      window.prompt = () => {
        throw new Error('prompt() is not supported.')
      }
      const get = navigator.credentials.get.bind(navigator.credentials)
      const createCredential = navigator.credentials.create.bind(navigator.credentials)
      navigator.credentials.create = async (options) => {
        if (options?.publicKey) {
          const record: unknown = Reflect.get(window, 'recordRegistrationOptions')
          if (typeof record === 'function')
            await record({
              hints: Reflect.get(options.publicKey, 'hints'),
              authenticatorSelection: options.publicKey.authenticatorSelection,
              excludedCredentials: options.publicKey.excludeCredentials?.length ?? 0,
            })
        }
        return createCredential(options)
      }
      navigator.credentials.get = async (options) => {
        if (options?.publicKey) {
          const record: unknown = Reflect.get(window, 'recordWebAuthnOptions')
          if (typeof record !== 'function') throw new Error('Fixture WebAuthn observer is unavailable')
          await record({
            hints: Reflect.get(options.publicKey, 'hints'),
            userVerification: options.publicKey.userVerification,
          })
        }
        return get(options)
      }
    }
    await context.addInitScript(observeWebAuthn)
    const page = await context.newPage()
    const themeScreenshots = process.env.TENGRI_IDENTITY_SCREENSHOTS
    if (themeScreenshots) mkdirSync(themeScreenshots, { recursive: true })
    const checkTheme = async (screen: string) => {
      await browserExpect(page).toHaveTitle('Sign in to Tengri')
      await browserExpect(page.locator('.tengri-brand')).toHaveText('Tengri')
      await browserExpect(page.locator('.tengri-mark img')).toBeVisible()
      await browserExpect(page.locator('link[rel="icon"]')).toHaveAttribute('href', /\/img\/fruit-pear\.svg$/)
      for (const viewport of [
        { width: 1280, height: 900 },
        { width: 320, height: 740 },
      ]) {
        await page.setViewportSize(viewport)
        await page.evaluate(() => document.fonts.ready)
        await page
          .locator('.tengri-window')
          .evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)))
        expect(await page.evaluate(() => document.fonts.check('14px Geist'))).toBe(true)
        expect(await page.locator('body').evaluate((element) => getComputedStyle(element).fontFamily)).toContain(
          'Geist',
        )
        expect(
          await page
            .locator('.tengri-mark img')
            .evaluate((element) => element instanceof HTMLImageElement && element.naturalWidth > 0),
        ).toBe(true)
        expect(await page.locator('body').evaluate((element) => element.scrollWidth <= window.innerWidth)).toBe(true)
        await browserExpect(page.locator('.tengri-window')).toBeInViewport()
        const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
        expect(accessibility.violations).toEqual([])
        if (themeScreenshots)
          await page.screenshot({
            path: path.join(themeScreenshots, `${screen}-${viewport.width}.png`),
            fullPage: true,
          })
      }
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      expect(await page.locator('.tengri-window').evaluate((element) => getComputedStyle(element).animationName)).toBe(
        'none',
      )
      await page.emulateMedia({ reducedMotion: 'no-preference' })
    }
    const cdp = await context.newCDPSession(page)
    await cdp.send('WebAuthn.enable')
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'usb',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    })
    await page.goto(base)
    await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
    await page.getByRole('link', { name: 'GitHub fixture 1', exact: true }).click()
    await browserExpect(page.getByRole('heading', { name: 'Set up your passkey', exact: true }))
      .toBeVisible({ timeout: 20_000 })
      .catch(async () => {
        throw new Error(
          'Isolated broker page: ' +
            (await page.locator('body').innerText()).slice(0, 1500) +
            '\n' +
            readFileSync(kc.log, 'utf8')
              .split('\n')
              .filter((line) => line.includes('WARN') || line.includes('ERROR'))
              .slice(-8)
              .join('\n'),
        )
      })
    await page.waitForLoadState('domcontentloaded')
    await checkTheme('setup')
    await page.keyboard.press('Tab')
    await page.locator('#registerWebAuthn').focus()
    expect(await page.locator('#registerWebAuthn').evaluate((element) => getComputedStyle(element).outlineStyle)).toBe(
      'solid',
    )
    await page.keyboard.press('Enter')
    await page
      .waitForURL((url) => url.origin === base, { timeout: 20_000 })
      .catch(async (cause: unknown) => {
        throw new Error('Isolated passkey enrollment: ' + (await page.locator('body').innerText()).slice(0, 1200), {
          cause,
        })
      })
    if (new URL(page.url()).pathname !== '/') {
      const denied = await control.query(
        "SELECT receipt->>'reason' AS reason FROM ofz.audit WHERE (receipt->>'allowed')::boolean=false ORDER BY sequence DESC LIMIT 3",
      )
      throw new Error(
        'Isolated callback result: ' +
          (await page.locator('body').innerText()).slice(0, 500) +
          '\n' +
          JSON.stringify(denied.rows) +
          '\n' +
          apiLogs.slice(-1000),
      )
    }
    await browserExpect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible()
    await browserExpect(page.getByText('GitHub #1', { exact: true }).first()).toBeVisible()
    await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false })
    const sessions = await control.query(
      'SELECT human_id,github_id,mfa_at_ms,expires_at_ms,idle_deadline_ms,token_hash FROM ofz.sessions',
    )
    expect(sessions.rowCount).toBe(1)
    expect(establishmentAttempts).toHaveLength(2)
    expect(establishmentAttempts[0]).toBe(establishmentAttempts[1])
    expect(
      (
        await control.query(
          "SELECT count(*) FROM ofz.audit WHERE (receipt->>'action')::integer=32 AND (receipt->>'allowed')::boolean",
        )
      ).rows[0]?.count,
    ).toBe('1')
    expect(sessions.rows[0]?.github_id).toBe('1')
    expect(Number(sessions.rows[0]?.mfa_at_ms)).toBeGreaterThan(0)
    // An independent handler invocation inspects the opaque cookie through Ofz, without browser state.
    const cookies = await context.cookies(base)
    const opaque = cookies.find((cookie) => cookie.name === '__Host-tengri-session')
    expect(opaque?.httpOnly).toBe(true)
    expect(opaque?.secure).toBe(true)
    const inspected = await getTengriIdentity(new Headers({ cookie: `__Host-tengri-session=${opaque?.value}` }))
    expect(inspected?.session.githubId).toBe('1')

    if (!inspected) throw new Error('Verified fixture session missing')
    await new Promise<void>((resolve, reject) => {
      const runtime = spawn(
        'cargo',
        [
          'test',
          '--manifest-path',
          path.join(root, 'services/tengri/Cargo.toml'),
          '--locked',
          '--bin',
          'tengri',
          'ofz_wire_runtime_lifecycle_and_authority',
          '--',
          '--ignored',
          '--nocapture',
        ],
        {
          env: {
            ...process.env,
            TENGRI_OFZ_WIRE_FIXTURE: '1',
            TENGRI_OFZ_FIXTURE_HUMAN: inspected.session.humanId,
            TENGRI_OFZ_FIXTURE_SESSION: inspected.session.id,
            TENGRI_RUNTIME_STATE_FIXTURE: '1',
            TENGRI_DATABASE_DSN: `host=localhost port=${port} dbname=tengri_control user=tengri_controller sslmode=require`,
            TENGRI_DATABASE_PASSWORD_FILE: secret('controller-password', 'fixture-controller'),
            TENGRI_DATABASE_CA_FILE: process.env.OFZ_TEST_CA_FILE || '',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      processes.push(runtime)
      let output = ''
      const retain = (bytes: Buffer) => {
        output = (output + bytes.toString()).slice(-16000)
      }
      runtime.stdout?.on('data', retain)
      runtime.stderr?.on('data', retain)
      runtime.once('error', reject)
      runtime.once('exit', (code) => {
        if (code !== 0 || !output.includes('test result: ok. 1 passed; 0 failed')) {
          reject(new Error(`Runtime Ofz wire fixture failed: ${output}`))
          return
        }
        console.log(output.split('\n').find((line) => line.startsWith('PASS: real controller Ofz mTLS')))
        resolve()
      })
    })

    // Routing removes the failed backend; the unchanged gRPC target must reconnect to the surviving process.
    const failoverStarted = Date.now()
    apiEndpoint.route(secondApiPort)
    firstApi.kill('SIGKILL')
    await once(firstApi, 'exit')
    let survivingIdentity: Awaited<ReturnType<typeof getTengriIdentity>> | undefined
    let failoverError: unknown
    while (Date.now() - failoverStarted < 30_000) {
      try {
        survivingIdentity = await getTengriIdentity(new Headers({ cookie: `__Host-tengri-session=${opaque?.value}` }))
        break
      } catch (error) {
        failoverError = error
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    if (!survivingIdentity)
      throw new Error('Surviving Ofz replica did not recover the shared browser session within 30 seconds', {
        cause: failoverError,
      })
    expect(survivingIdentity.session.id).toBe(inspected.session.id)
    expect(Date.now() - failoverStarted).toBeLessThan(30_000)
    await page.reload()
    await browserExpect(page.getByRole('button', { name: 'Apply change', exact: true })).toBeVisible()
    console.log(
      'PASS: two real Ofz processes share SQL authority; unchanged client target recovers the same passkey session after SIGKILL of the serving replica',
    )

    // Repeated bootstrap must rotate both credentials while retaining enrolled users/passkeys.
    const usersBefore = z.array(z.object({ id: z.string() })).parse(await (await adminCall('/users')).json())
    const firstUser = usersBefore[0]
    if (!firstUser) throw new Error('Enrolled fixture user missing')
    const credentialsBefore = await (await adminCall(`/users/${firstUser.id}/credentials`)).json()
    const productionRealm = z
      .object({ clients: z.array(z.unknown()) })
      .parse(JSON.parse(readFileSync(path.join(root, 'argocd/applications/keycloak/tengri/realm.json'), 'utf8')))
    const productionClient = z
      .object({ clientId: z.literal('tengri-bff'), redirectUris: z.array(z.string()), webOrigins: z.array(z.string()) })
      .parse(productionRealm.clients[0])
    const productionProvider = { ...provider, config: { ...provider.config } }
    delete productionProvider.config.baseUrl
    delete productionProvider.config.apiUrl
    delete productionProvider.config.githubJsonFormat
    await adminCall('/identity-provider/instances/github', 'PUT', productionProvider)
    await adminCall(`/clients/${client.id}`, 'PUT', productionClient)
    githubSecret = 'fixture-github-secret-rotated'
    const rotatedBffSecret = 'fixture-bff-secret-rotated-not-production-0000000'
    const webAuthnPolicy = Object.fromEntries(
      Object.entries(z.record(z.string(), z.unknown()).parse(await (await adminCall('')).json())).filter(
        ([key]) => key.startsWith('webAuthnPolicy') && !key.startsWith('webAuthnPolicyPasswordless'),
      ),
    )
    await adminCall('', 'PUT', {
      ...webAuthnPolicy,
      loginTheme: 'keycloak',
      sslRequired: 'none',
      webAuthnPolicyUserVerificationRequirement: 'required',
    })
    expect(
      z.object({ webAuthnPolicyUserVerificationRequirement: z.string() }).parse(await (await adminCall('')).json())
        .webAuthnPolicyUserVerificationRequirement,
    ).toBe('required')
    expect(() => bootstrap(githubSecret, rotatedBffSecret)).toThrow()
    await adminCall('', 'PUT', { sslRequired: 'all' })
    bootstrap(githubSecret, rotatedBffSecret)
    expect(await (await adminCall('')).json()).toMatchObject({
      ...webAuthnPolicy,
      loginTheme: 'tengri',
      webAuthnPolicyUserVerificationRequirement: 'discouraged',
    })
    expect(z.array(z.object({ id: z.string() })).parse(await (await adminCall('/users')).json())).toEqual(usersBefore)
    expect(await (await adminCall(`/users/${firstUser.id}/credentials`)).json()).toEqual(credentialsBefore)
    const currentProvider = z
      .object({ config: z.record(z.string(), z.string()) })
      .passthrough()
      .parse(await (await adminCall('/identity-provider/instances/github')).json())
    currentProvider.config = {
      ...currentProvider.config,
      baseUrl: `http://127.0.0.1:${githubAddress.port}`,
      apiUrl: `http://127.0.0.1:${githubAddress.port}`,
      githubJsonFormat: 'true',
    }
    await adminCall('/identity-provider/instances/github', 'PUT', currentProvider)
    await adminCall(`/clients/${client.id}`, 'PUT', { redirectUris: [base + '/api/auth/callback'], webOrigins: [base] })
    writeFileSync(z.string().parse(process.env.TENGRI_OIDC_CLIENT_SECRET_FILE), rotatedBffSecret)
    for (const [secretValue, status] of [
      ['fixture-bff-secret-not-production-0000000', 401],
      [rotatedBffSecret, 400],
    ] as const) {
      const response = await fetch(adminBase + '/realms/tengri/protocol/openid-connect/token', {
        method: 'POST',
        body: new URLSearchParams({
          client_id: 'tengri-bff',
          client_secret: secretValue,
          grant_type: 'authorization_code',
          code: 'invalid-fixture-code',
          redirect_uri: base + '/api/auth/callback',
        }),
      })
      expect(response.status).toBe(status)
      expect(z.object({ error: z.string() }).parse(await response.json()).error).toBe(
        status === 401 ? 'unauthorized_client' : 'invalid_grant',
      )
    }

    const administrationVersion = BigInt(
      (await control.query('SELECT version FROM ofz.platform_state')).rows[0]?.version,
    )
    const applyChange = async (status: number) => {
      const result = page.waitForResponse(
        (response) => response.url() === base + '/api/tengri/access' && response.request().method() === 'POST',
      )
      await page.getByRole('button', { name: 'Apply change', exact: true }).click()
      expect((await result).status()).toBe(status)
    }
    const postAccess = (command: Record<string, unknown>) =>
      page.evaluate(async (input) => {
        const response = await fetch('/api/tengri/access', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        })
        return { status: response.status, body: await response.json() }
      }, command)
    await page.getByLabel('Change', { exact: true }).selectOption('quota')
    await page.getByLabel('GitHub username', { exact: true }).fill('fixture-1')
    await page.getByLabel('total', { exact: true }).fill('3')
    await page.getByLabel('active', { exact: true }).fill('2')
    await page.getByLabel('retainedGiB', { exact: true }).fill('96')
    await page.getByLabel('Reason', { exact: true }).fill('Isolated quota qualification')
    await applyChange(200)
    expect(identityLookups).toBeGreaterThan(0)
    await browserExpect(
      page.getByText(`Policy version ${administrationVersion + BigInt(1)}`, { exact: true }),
    ).toBeVisible()
    expect(
      (
        await control.query(
          'SELECT total_workspaces,active_workspaces,retained_bytes FROM ofz.quotas WHERE human_id=$1',
          [humans[0]?.humanId],
        )
      ).rows[0],
    ).toMatchObject({ total_workspaces: 3, active_workspaces: 2, retained_bytes: String(96 * 1_073_741_824) })

    await page.getByLabel('Change', { exact: true }).selectOption('membership')
    await page.getByLabel('GitHub username', { exact: true }).fill('fixture-2')
    await page.getByLabel('Role', { exact: true }).selectOption('administrator')
    await page.getByLabel('Enable this access', { exact: true }).uncheck()
    await page.getByLabel('Reason', { exact: true }).fill('Attempt to remove required second administrator')
    await applyChange(422)
    await browserExpect(page.getByRole('alert').filter({ hasText: 'constraint' })).toBeVisible()
    expect((await control.query('SELECT count(*) FROM ofz.memberships WHERE role=2')).rows[0]?.count).toBe('2')

    await page.getByLabel('GitHub username', { exact: true }).fill('fixture-3')
    await page.getByLabel('Role', { exact: true }).selectOption('member')
    await page.getByLabel('Enable this access', { exact: true }).check()
    await page.getByLabel('Reason', { exact: true }).fill('Admit an isolated member through the browser')
    await applyChange(200)
    await browserExpect(
      page.getByText(`Policy version ${administrationVersion + BigInt(2)}`, { exact: true }),
    ).toBeVisible()
    await browserExpect(page.getByText('GitHub #3', { exact: true })).toBeVisible()

    // Seed a stopped, enrolled workspace; creation and enrollment are exercised by the controller wire fixture above.
    const scopedWorkspace = randomUUID()
    const scopedHome = randomUUID()
    await control.query(
      "WITH enrolled AS (INSERT INTO ofz.reservations(id,owner_id,home_bytes,workspace_uid,state) VALUES($1,$2,34359738368,$3,'enrolled') RETURNING id) INSERT INTO ofz.workspaces(uid,owner_id,home_uid,reservation_id,home_bytes) SELECT $3,$2,$4,id,34359738368 FROM enrolled",
      [randomUUID(), inspected.session.humanId, scopedWorkspace, scopedHome],
    )
    await nativeCall('/v1/relationships/write', {
      updates: [
        relation('workspace', scopedWorkspace, 'platform', 'platform', 'lab'),
        relation('workspace', scopedWorkspace, 'owner', 'human', inspected.session.humanId),
      ],
    })
    await page.goto(base + '/?workspace=' + scopedWorkspace)
    const contentOptIn = page.getByLabel('Approve bounded Viewer content access', { exact: true })
    await browserExpect(contentOptIn).not.toBeChecked()
    await page.getByLabel('GitHub username', { exact: true }).fill('fixture-3')
    await page.getByLabel('Reason', { exact: true }).fill('Grant metadata-only Viewer access')
    await applyChange(200)
    const viewerRow = page.getByRole('row').filter({ has: page.getByText('GitHub #3', { exact: true }) })
    await browserExpect(viewerRow.getByText('Metadata only', { exact: true })).toBeVisible()
    const viewerId = createHash('sha256').update('github:3').digest('hex')
    const storedViewer = async () =>
      (
        await control.query('SELECT role,scope FROM ofz.collaborators WHERE workspace_uid=$1 AND human_id=$2', [
          scopedWorkspace,
          viewerId,
        ])
      ).rows[0]
    expect(await storedViewer()).toEqual({ role: 3, scope: null })

    await contentOptIn.check()
    const roots = page.getByLabel('File roots under /workspace', { exact: true })
    await roots.fill('/workspace/../private')
    const lookupsBeforeInvalidScope = identityLookups
    const versionBeforeInvalidScope = (await control.query('SELECT version FROM ofz.platform_state')).rows[0]?.version
    await page.getByRole('button', { name: 'Apply change', exact: true }).click()
    await browserExpect(roots).toHaveAttribute('aria-invalid', 'true')
    await browserExpect(page.getByRole('alert').filter({ hasText: 'canonical path under /workspace' })).toBeVisible()
    expect(identityLookups).toBe(lookupsBeforeInvalidScope)
    expect((await control.query('SELECT version FROM ofz.platform_state')).rows[0]?.version).toBe(
      versionBeforeInvalidScope,
    )
    await roots.fill(
      Array.from({ length: 16 }, (_, index) => {
        const prefix = `/workspace/project-${index}/`
        return prefix + 'x'.repeat(4096 - prefix.length)
      }).join('\n'),
    )
    await page.getByRole('button', { name: 'Apply change', exact: true }).click()
    await browserExpect(page.getByRole('alert').filter({ hasText: 'Access request exceeds 64 KiB' })).toBeVisible()
    expect(identityLookups).toBe(lookupsBeforeInvalidScope)
    expect((await control.query('SELECT version FROM ofz.platform_state')).rows[0]?.version).toBe(
      versionBeforeInvalidScope,
    )
    expect(await storedViewer()).toEqual({ role: 3, scope: null })
    await roots.fill('/workspace/src ')
    await page.getByLabel('Codex thread IDs', { exact: true }).fill(' shared-id ')
    await page.getByLabel('Terminal IDs', { exact: true }).fill(' shared-id ')
    await page.getByLabel('Maximum bytes', { exact: true }).fill('4096')
    await page.getByLabel('Maximum items', { exact: true }).fill('20')
    await browserExpect(page.getByLabel('Allow browser screenshots', { exact: true })).not.toBeChecked()
    await applyChange(200)
    for (const [label, target] of [
      ['File roots', '/workspace/src '],
      ['Codex thread IDs', ' shared-id '],
      ['Terminal IDs', ' shared-id '],
    ]) {
      const group = viewerRow.locator('dl > div').filter({ has: page.getByText(label, { exact: true }) })
      await browserExpect(group.getByText(JSON.stringify(target), { exact: true })).toBeVisible()
    }
    const approvedScope = {
      file_roots: ['/workspace/src '],
      thread_ids: [' shared-id '],
      terminal_ids: [' shared-id '],
      browser_screenshot: false,
      max_bytes: 4096,
      max_items: 20,
    }
    expect(await storedViewer()).toEqual({ role: 3, scope: approvedScope })
    await browserExpect(viewerRow.getByText(/Browser status · up to 4096 bytes \/ 20 items/)).toBeVisible()

    await page.getByLabel('GitHub username', { exact: true }).fill('fixture-2')
    await browserExpect(contentOptIn).not.toBeChecked()
    await page.getByLabel('GitHub username', { exact: true }).fill('fixture-3')
    await browserExpect(contentOptIn).not.toBeChecked()
    await contentOptIn.check()
    await roots.fill('/workspace/narrow')
    await page.getByLabel('Codex thread IDs', { exact: true }).fill('')
    await page.getByLabel('Terminal IDs', { exact: true }).fill('')
    await page.getByLabel('Allow browser screenshots', { exact: true }).check()
    await applyChange(200)
    await browserExpect(viewerRow.getByText(JSON.stringify('/workspace/narrow'), { exact: true })).toBeVisible()
    await browserExpect(viewerRow.getByText(/Browser status and screenshots/)).toBeVisible()
    expect(await storedViewer()).toEqual({
      role: 3,
      scope: {
        ...approvedScope,
        file_roots: ['/workspace/narrow'],
        thread_ids: [],
        terminal_ids: [],
        browser_screenshot: true,
      },
    })
    await contentOptIn.uncheck()
    await applyChange(200)
    await browserExpect(viewerRow.getByText('Metadata only', { exact: true })).toBeVisible()
    expect(await storedViewer()).toEqual({ role: 3, scope: null })
    const boundaryRoots = Array.from({ length: 15 }, (_, index) => {
      const prefix = `/workspace/maximum-${index}/`
      return prefix + 'x'.repeat(4096 - prefix.length)
    })
    const finalPrefix = '/workspace/maximum-final/'
    boundaryRoots.push(finalPrefix)
    const boundaryCommand = {
      action: 'collaborator',
      operationId: randomUUID(),
      expectedVersion: (await control.query('SELECT version FROM ofz.platform_state')).rows[0]?.version,
      reason: 'Maximum accepted Viewer command',
      workspaceUid: scopedWorkspace,
      login: 'fixture-3',
      role: 'viewer',
      enabled: true,
      scope: {
        fileRoots: boundaryRoots,
        threadIds: [],
        terminalIds: [],
        browserScreenshot: false,
        maxBytes: 1024,
        maxItems: 20,
      },
    }
    boundaryRoots[15] =
      finalPrefix + 'x'.repeat(MAX_ACCESS_COMMAND_BYTES - Buffer.byteLength(JSON.stringify(boundaryCommand)))
    accessCommandSchema.parse(boundaryCommand)
    expect(Buffer.byteLength(JSON.stringify(boundaryCommand))).toBe(MAX_ACCESS_COMMAND_BYTES)
    expect((await postAccess(boundaryCommand)).status).toBe(200)
    expect((await storedViewer()).scope.file_roots).toEqual(boundaryRoots)
    expect(
      (
        await postAccess({
          ...boundaryCommand,
          operationId: randomUUID(),
          expectedVersion: (await control.query('SELECT version FROM ofz.platform_state')).rows[0]?.version,
          scope: undefined,
        })
      ).status,
    ).toBe(200)
    expect(await storedViewer()).toEqual({ role: 3, scope: null })
    const metadataGrant = randomUUID()
    expect(
      (
        await postAccess({
          action: 'grant',
          operationId: randomUUID(),
          expectedVersion: (await control.query('SELECT version FROM ofz.platform_state')).rows[0]?.version,
          reason: 'Verify metadata-only diagnostic scope display',
          workspaceUid: scopedWorkspace,
          grantId: metadataGrant,
          agentId: randomUUID(),
          resource: { kind: 'workspace', id: scopedWorkspace },
          permissions: ['metadata'],
          scope: {
            fileRoots: [],
            threadIds: [],
            terminalIds: [],
            browserScreenshot: false,
            maxBytes: 1024,
            maxItems: 20,
          },
          expiresAt: new Date(Date.now() + 300000).toISOString(),
          proofKeyThumbprint: Buffer.alloc(32, 1).toString('base64url'),
        })
      ).status,
    ).toBe(200)
    await page.reload()
    const diagnosticRow = page
      .getByRole('row')
      .filter({ has: page.getByText(`Grant ${metadataGrant}`, { exact: true }) })
    await browserExpect(diagnosticRow).toBeVisible()
    await browserExpect(diagnosticRow).not.toContainText('Browser status')
    await browserExpect(diagnosticRow.getByText('up to 1024 bytes / 20 items', { exact: true })).toBeVisible()
    expect(
      (
        await postAccess({
          action: 'revoke',
          operationId: randomUUID(),
          expectedVersion: (await control.query('SELECT version FROM ofz.platform_state')).rows[0]?.version,
          reason: 'Remove isolated metadata diagnostic',
          workspaceUid: scopedWorkspace,
          grantId: metadataGrant,
        })
      ).status,
    ).toBe(200)
    expect(
      (await control.query('SELECT home_uid,state,running FROM ofz.workspaces WHERE uid=$1', [scopedWorkspace]))
        .rows[0],
    ).toEqual({
      home_uid: scopedHome,
      state: 'active',
      running: false,
    })
    console.log(
      'PASS: real Access UI and BFF preserve metadata-only Viewers, reject invalid scope inline before identity lookup, commit exact bounded scopes, require a new subject opt-in, narrow targets and remove content without starting the retained workspace',
    )
    await page.goto(base)
    await browserExpect(page.getByRole('button', { name: 'Apply change', exact: true })).toBeVisible()

    await control.query('UPDATE ofz.sessions SET mfa_at_ms=ofz.now_ms()-300001 WHERE id=$1', [inspected?.session.id])
    await page.getByLabel('Change', { exact: true }).selectOption('quota')
    await page.getByLabel('GitHub username', { exact: true }).fill('fixture-1')
    await page.getByLabel('Reason', { exact: true }).fill('A stale passkey must not authorize this change')
    await applyChange(428)
    await browserExpect(page.getByRole('alert').filter({ hasText: 'Verify with your passkey' })).toBeVisible()
    await page.getByRole('button', { name: 'Verify passkey', exact: true }).click()
    await page.getByRole('link', { name: 'GitHub fixture 1', exact: true }).click()
    await browserExpect(page.locator('#authenticateWebAuthnButton')).toBeVisible()
    await page.waitForLoadState('domcontentloaded')
    await checkTheme('verify')
    await browserExpect(page.getByRole('heading', { name: 'Verify your passkey', exact: true })).toBeVisible()
    await browserExpect(page.getByRole('link', { name: 'Use another account', exact: true })).toBeVisible()
    const subjectBeforeFailover = (
      await control.query('SELECT identity_subject FROM ofz.sessions WHERE id=$1', [inspected.session.id])
    ).rows[0]?.identity_subject
    const credentialIdentities = async () =>
      z
        .array(z.object({ id: z.string(), type: z.string(), userLabel: z.string() }))
        .parse(await (await adminCall(`/users/${subjectBeforeFailover}/credentials`)).json())
    const passkeysBeforeFailover = await credentialIdentities()
    const keycloakFailoverStarted = Date.now()
    keycloakEndpoint.route(kcSecondaryHttps)
    adminBase = `http://127.0.0.1:${kcSecondaryHttp}`
    kc.server.kill('SIGKILL')
    await once(kc.server, 'exit')
    await page.locator('#authenticateWebAuthnButton').click()
    await page.waitForURL(base + '/')
    await browserExpect(page.getByText('GitHub #1', { exact: true }).first()).toBeVisible()
    expect(await getTengriIdentity(new Headers({ cookie: `__Host-tengri-session=${opaque?.value}` }))).toBeNull()
    const replacement = (await context.cookies(base)).find((value) => value.name === '__Host-tengri-session')
    expect(replacement?.value).not.toBe(opaque?.value)
    expect(Date.now() - keycloakFailoverStarted).toBeLessThan(30_000)
    expect(await credentialIdentities()).toEqual(passkeysBeforeFailover)
    const survivingSession = await getTengriIdentity(
      new Headers({ cookie: `__Host-tengri-session=${replacement?.value}` }),
    )
    expect(survivingSession?.session.humanId).toBe(inspected.session.humanId)
    expect(
      (await control.query('SELECT identity_subject FROM ofz.sessions WHERE id=$1', [survivingSession?.session.id]))
        .rows[0]?.identity_subject,
    ).toBe(subjectBeforeFailover)
    console.log(
      'PASS: two production Keycloak 26.7.4 nodes with jdbc-ping and transport mTLS preserve an in-flight passkey challenge, subject and credentials after serving-node SIGKILL within 30 seconds',
    )

    // A second numeric GitHub identity has the same verified email upstream.
    const secondContext = await browser.newContext({ ignoreHTTPSErrors: true })
    const platformWebAuthnRequests: unknown[] = []
    await secondContext.exposeFunction('recordWebAuthnOptions', (options: unknown) => {
      platformWebAuthnRequests.push(options)
    })
    await secondContext.addInitScript(observeWebAuthn)
    const secondPage = await secondContext.newPage()
    const secondCdp = await secondContext.newCDPSession(secondPage)
    await secondCdp.send('WebAuthn.enable')
    await secondCdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    })
    const enroll = async (id: string) => {
      await secondPage.goto(base)
      await secondPage.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
      await secondPage.getByRole('link', { name: `GitHub fixture ${id}`, exact: true }).click()
      await browserExpect(secondPage.getByRole('heading', { name: 'Set up your passkey', exact: true })).toBeVisible()
      await secondPage.waitForLoadState('domcontentloaded')
      await secondPage.getByRole('button', { name: 'Create passkey', exact: true }).click()
      await secondPage
        .waitForURL((url) => url.origin === base && (id === '999' || url.pathname === '/'), {
          timeout: 10_000,
        })
        .catch(async () => {
          throw new Error(
            'Isolated enrollment result: ' + (await secondPage.locator('body').innerText()).slice(0, 1200),
          )
        })
      if (id !== '999') {
        await browserExpect(secondPage.getByRole('button', { name: 'Sign out', exact: true }))
          .toBeVisible()
          .catch(async (cause: unknown) => {
            const denied = await control.query(
              "SELECT receipt->>'reason' AS reason FROM ofz.audit WHERE (receipt->>'allowed')::boolean=false ORDER BY sequence DESC LIMIT 3",
            )
            throw new Error(
              `Fixture ${id} enrollment result: ` +
                (await secondPage.locator('body').innerText()).slice(0, 1600) +
                '\n' +
                JSON.stringify(denied.rows),
              { cause },
            )
          })
        const credential = (await secondContext.cookies(base)).find((value) => value.name === '__Host-tengri-session')
        const identity = await getTengriIdentity(new Headers({ cookie: `__Host-tengri-session=${credential?.value}` }))
        expect(identity?.session.githubId).toBe(id)
      }
    }
    await enroll('2')
    const distinct = await control.query(
      "SELECT DISTINCT identity_subject,github_id FROM ofz.sessions WHERE github_id IN ('1','2')",
    )
    expect(distinct.rowCount).toBe(2)
    expect(new Set(distinct.rows.map((row) => row.identity_subject)).size).toBe(2)
    await secondPage.getByRole('button', { name: 'Sign out', exact: true }).click()
    await browserExpect(secondPage.getByRole('button', { name: 'Sign in with GitHub', exact: true })).toBeVisible()
    await secondPage.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
    await secondPage.getByRole('link', { name: 'GitHub fixture 2', exact: true }).click()
    await browserExpect(secondPage.locator('#authenticateWebAuthnButton')).toBeVisible()
    await secondPage.waitForLoadState('domcontentloaded')
    await secondPage.locator('#authenticateWebAuthnButton').click()
    await secondPage.waitForURL(base + '/')
    await browserExpect(secondPage.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible()
    expect(platformWebAuthnRequests.length).toBeGreaterThan(0)
    for (const request of platformWebAuthnRequests)
      expect(request).toEqual({ hints: ['client-device', 'hybrid', 'security-key'], userVerification: 'discouraged' })
    await secondPage.getByRole('button', { name: 'Sign out', exact: true }).click()
    await browserExpect(secondPage.getByRole('button', { name: 'Sign in with GitHub', exact: true })).toBeVisible()
    // The nonmember is a separate upstream identity, with no existing Keycloak SSO cookie.
    await secondContext.clearCookies()
    await enroll('3')
    const lookupsBeforeDenial = identityLookups
    const memberDenied = await secondPage.evaluate(async (operationId) => {
      const response = await fetch('/api/tengri/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'membership',
          operationId,
          expectedVersion: '3',
          reason: 'Member must not consume external identity lookups',
          login: 'fixture-2',
          role: 'administrator',
          enabled: true,
        }),
      })
      return { status: response.status, body: await response.json() }
    }, randomUUID())
    expect(memberDenied.status).toBe(403)
    expect(identityLookups).toBe(lookupsBeforeDenial)
    expect(z.object({ auditReceiptId: z.uuid() }).parse(memberDenied.body).auditReceiptId).toBeTruthy()
    await secondPage.getByRole('button', { name: 'Sign out', exact: true }).click()
    await secondContext.clearCookies()
    await enroll('999')
    const denied = z
      .object({ error: z.string(), auditReceiptId: z.uuid() })
      .parse(JSON.parse(await secondPage.locator('body').innerText()))
    expect(denied.error).toContain('denied')
    expect(
      (await control.query("SELECT receipt->>'reason' AS reason FROM ofz.audit WHERE id=$1", [denied.auditReceiptId]))
        .rows[0]?.reason,
    ).toBe('platform admission required')
    expect((await control.query("SELECT count(*) FROM ofz.sessions WHERE github_id='999'")).rows[0]?.count).toBe('0')

    const scopes = z
      .array(z.object({ id: z.string(), name: z.string() }))
      .parse(await (await adminCall('/client-scopes')).json())
    const acrScope = scopes.find((scope) => scope.name === 'acr')
    if (!acrScope) throw new Error('Fixture ACR scope missing')
    await adminCall(`/clients/${client.id}/default-client-scopes/${acrScope.id}`, 'DELETE')
    await adminCall(`/clients/${client.id}/protocol-mappers/models`, 'POST', {
      name: 'fixture-assurance-downgrade',
      protocol: 'openid-connect',
      protocolMapper: 'oidc-hardcoded-claim-mapper',
      config: {
        'claim.name': 'acr',
        'claim.value': '1',
        'jsonType.label': 'String',
        'id.token.claim': 'true',
        'access.token.claim': 'false',
      },
    })
    await page.getByRole('button', { name: 'Verify passkey', exact: true }).click()
    await page.getByRole('link', { name: 'GitHub fixture 1', exact: true }).click()
    await page.locator('#authenticateWebAuthnButton').click()
    await page.waitForURL((url) => url.origin === base)
    const assuranceDenied = z
      .object({ auditReceiptId: z.uuid() })
      .parse(JSON.parse(await page.locator('body').innerText()))
    expect(
      (
        await control.query("SELECT receipt->>'reason' AS reason FROM ofz.audit WHERE id=$1", [
          assuranceDenied.auditReceiptId,
        ])
      ).rows[0]?.reason,
    ).toBe('verified passkey assurance required')
    expect((await control.query('SELECT count(*) FROM ofz.sessions')).rows[0]?.count).toBe('5')
    const mappers = z
      .array(z.object({ id: z.string(), name: z.string() }))
      .parse(await (await adminCall(`/clients/${client.id}/protocol-mappers/models`)).json())
    const badMapper = mappers.find((mapper) => mapper.name === 'fixture-assurance-downgrade')
    if (!badMapper) throw new Error('Fixture assurance mapper missing')
    await adminCall(`/clients/${client.id}/protocol-mappers/models/${badMapper.id}`, 'DELETE')
    await adminCall(`/clients/${client.id}/default-client-scopes/${acrScope.id}`, 'PUT')
    await page.goto(base)
    await browserExpect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible()

    const promote = await postAccess({
      action: 'membership',
      operationId: randomUUID(),
      expectedVersion: (await control.query('SELECT version FROM ofz.platform_state')).rows[0]?.version,
      reason: 'Retain two administrators during self-demotion recovery',
      login: 'fixture-3',
      role: 'administrator',
      enabled: true,
    })
    expect(promote.status).toBe(200)
    const selfDemotion = {
      action: 'membership',
      operationId: randomUUID(),
      expectedVersion: (await control.query('SELECT version FROM ofz.platform_state')).rows[0]?.version,
      reason: 'Recover a committed self-demotion after a lost response',
      login: 'fixture-1',
      role: 'administrator',
      enabled: false,
    }
    loseCommandReply = true
    expect((await postAccess(selfDemotion)).status).toBe(503)
    expect(
      (await control.query('SELECT count(*) FROM ofz.memberships WHERE human_id=$1 AND role=2', [humans[0]?.humanId]))
        .rows[0]?.count,
    ).toBe('0')
    const lookupsAfterCommit = identityLookups
    const committed = await postAccess(selfDemotion)
    expect(committed.status).toBe(200)
    const committedReceipt = z
      .object({ receipt: z.object({ operationId: z.uuid(), auditReceiptId: z.uuid() }) })
      .parse(committed.body).receipt
    expect(committedReceipt.operationId).toBe(selfDemotion.operationId)
    expect(identityLookups).toBe(lookupsAfterCommit)
    expect((await postAccess({ ...selfDemotion, login: 'fixture-2' })).status).toBe(409)
    expect(
      (
        await control.query(
          "SELECT count(*) FROM ofz.audit WHERE receipt->>'operation_id'=$1 AND (receipt->>'allowed')::boolean",
          [selfDemotion.operationId],
        )
      ).rows[0]?.count,
    ).toBe('1')

    const attemptsBefore = (await bffAdmin.query('SELECT count(*) FROM tengri.oauth_attempts')).rows[0]?.count
    expect(
      await page.evaluate(async () => fetch('/api/auth/login', { method: 'HEAD' }).then((response) => response.status)),
    ).toBe(405)
    expect((await bffAdmin.query('SELECT count(*) FROM tengri.oauth_attempts')).rows[0]?.count).toBe(attemptsBefore)
    expect(
      await page.evaluate(async () =>
        fetch('/api/auth/callback?state=' + 'a'.repeat(43) + '&code=replay').then((response) => response.status),
      ),
    ).toBe(401)
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await browserExpect(page.getByRole('button', { name: 'Sign in with GitHub', exact: true })).toBeVisible()
    expect(await getTengriIdentity(new Headers({ cookie: `__Host-tengri-session=${replacement?.value}` }))).toBeNull()
    expect(
      (
        await control.query(
          "SELECT count(*) FROM ofz.audit WHERE (receipt->>'action')::integer=32 AND (receipt->>'allowed')::boolean",
        )
      ).rows[0]?.count,
    ).toBe('5')
    expect(webAuthnRequests.length).toBeGreaterThan(0)
    for (const request of webAuthnRequests)
      expect(request).toEqual({ hints: ['client-device', 'hybrid', 'security-key'], userVerification: 'discouraged' })
    const credentialsBeforeAddition = await credentialIdentities()
    await page.getByRole('button', { name: 'Add another passkey', exact: true }).click()
    await page.getByRole('link', { name: 'GitHub fixture 1', exact: true }).click()
    await browserExpect(page.locator('#authenticateWebAuthnButton')).toBeVisible()
    expect(await credentialIdentities()).toEqual(credentialsBeforeAddition)
    await page.locator('#authenticateWebAuthnButton').click()
    await browserExpect(page.getByRole('heading', { name: 'Set up your passkey', exact: true })).toBeVisible()
    await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: false })
    const { authenticatorId: platformAuthenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    })
    await page.getByRole('button', { name: 'Create passkey', exact: true }).click()
    await page.waitForURL(base + '/')
    expect(await credentialIdentities()).toHaveLength(credentialsBeforeAddition.length + 1)
    expect(await credentialIdentities()).toEqual(expect.arrayContaining(credentialsBeforeAddition))
    const labels = (await credentialIdentities()).map((credential) => credential.userLabel)
    expect(new Set(labels).size).toBe(labels.length)
    expect(registrations.at(-1)).toEqual({
      hints: ['client-device', 'hybrid', 'security-key'],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'discouraged' },
      excludedCredentials: credentialsBeforeAddition.length,
    })
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId })
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
    await page.getByRole('link', { name: 'GitHub fixture 1', exact: true }).click()
    await browserExpect(page.locator('#authenticateWebAuthnButton')).toBeVisible()
    await browserExpect(page.getByText('Available Passkeys', { exact: true })).toHaveCount(0)
    await browserExpect(page.getByText(/Passkey \(/)).toHaveCount(0)
    await browserExpect(page.getByText('Internal', { exact: true })).toHaveCount(0)
    await browserExpect(page.locator('#authn_select input[name="authn_use_chk"]')).toHaveCount(
      credentialsBeforeAddition.length + 1,
    )
    if (themeScreenshots)
      await page.screenshot({ path: path.join(themeScreenshots, 'verify-two-passkeys.png'), fullPage: true })
    await cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
      authenticatorId: platformAuthenticatorId,
      enabled: false,
    })
    await page.locator('#authenticateWebAuthnButton').click()
    await browserExpect(page.getByRole('button', { name: 'Check your passkey dialog', exact: true })).toBeDisabled()
    if (themeScreenshots)
      await page.screenshot({ path: path.join(themeScreenshots, 'verify-pending.png'), fullPage: true })
    await page.reload()
    await browserExpect(page.getByRole('button', { name: 'Continue with passkey', exact: true })).toBeEnabled()
    await cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
      authenticatorId: platformAuthenticatorId,
      enabled: true,
    })
    await page.locator('#authenticateWebAuthnButton').click()
    await page.waitForURL(base + '/')
    const phoneSession = (await context.cookies(base)).find((value) => value.name === '__Host-tengri-session')
    const phoneIdentity = await getTengriIdentity(
      new Headers({ cookie: `__Host-tengri-session=${phoneSession?.value}` }),
    )
    expect(phoneIdentity?.session.githubId).toBe('1')
    expect(phoneIdentity?.session.humanId).toBe(humans[0]?.humanId)
    const credentialsBeforeCancellation = await credentialIdentities()
    await page.getByRole('button', { name: 'Add another passkey', exact: true }).click()
    await page.getByRole('link', { name: 'GitHub fixture 1', exact: true }).click()
    await browserExpect(page.locator('#authenticateWebAuthnButton')).toBeVisible()
    await page.locator('#authenticateWebAuthnButton').click()
    await browserExpect(page.getByRole('heading', { name: 'Set up your passkey', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.waitForURL(base + '/')
    expect(await credentialIdentities()).toEqual(credentialsBeforeCancellation)
    console.log(
      'PASS: existing USB credential authorizes a second platform passkey; fresh mobile-sized login succeeds with the USB authenticator removed',
    )
    console.log(
      'PASS: real GitHub broker mapping with duplicate emails, passkey enrollment and fresh step-up, PKCE callback, SPIFFE Ofz wire, admission denial receipts, browser membership/quota changes, minimum administrators, shared sessions, atomic cookie replacement, committed-establishment and self-demotion lost-reply recovery, request collision rejection, logout and HEAD/replay denial',
    )
    await page.goto(issuer + '/protocol/openid-connect/auth?client_id=invalid-theme-fixture&response_type=code')
    await browserExpect(page.getByRole('heading', { name: 'Unable to continue', exact: true })).toBeVisible()
    await browserExpect(page.locator('#kc-error-message')).toContainText('Client not found')
    await checkTheme('error')
    console.log(
      'PASS: branded passkey setup, verification and error pages fit desktop and 320px, load Geist, respect reduced motion and pass WCAG A/AA browser checks',
    )
  },
  300_000,
)
