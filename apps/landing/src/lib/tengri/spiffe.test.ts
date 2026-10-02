import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'

void mock.module('server-only', () => ({}))
const { parseSpiffeId, parseSpiffeMaterial, SpiffeSource, verifySpiffePeer } = await import('./spiffe')
const id = 'spiffe://galactic.proompteng.ai/ns/proompteng/sa/proompteng'
const directory = mkdtempSync(path.join(tmpdir(), 'tengri-spiffe-'))
const protoPath = path.resolve(import.meta.dir, '../../../../../services/tengri/proto/spiffe/workloadapi.proto')
const definition = protoLoader.loadSync(protoPath, { defaults: true, keepCase: false })
const descriptor = grpc.loadPackageDefinition(definition)
const service = definition.SpiffeWorkloadAPI
if (!service || !('FetchX509SVID' in service)) throw new Error('Missing Workload API service')

let server: grpc.Server
let source: InstanceType<typeof SpiffeSource>
let calls = new Set<grpc.ServerWritableStream<object, object>>()
let initial: ReturnType<typeof makeSvid>
let rotated: ReturnType<typeof makeSvid>
let wrongIdentity: ReturnType<typeof makeSvid>

function openssl(...args: string[]) {
  execFileSync('openssl', args, { cwd: directory, stdio: 'ignore' })
}

function makeSvid(name: string, spiffeId: string) {
  openssl(
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    `${name}.key`,
    '-out',
    `${name}.csr`,
    '-subj',
    '/CN=fixture',
  )
  writeFileSync(
    path.join(directory, `${name}.ext`),
    [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature',
      'extendedKeyUsage=serverAuth,clientAuth',
      `subjectAltName=URI:${spiffeId}`,
    ].join('\n'),
  )
  openssl(
    'x509',
    '-req',
    '-in',
    `${name}.csr`,
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-out',
    `${name}.pem`,
    '-days',
    '1',
    '-extfile',
    `${name}.ext`,
  )
  openssl('pkcs8', '-topk8', '-nocrypt', '-in', `${name}.key`, '-outform', 'DER', '-out', `${name}.der`)
  return {
    spiffeId,
    x509Svid: new X509Certificate(readFileSync(path.join(directory, `${name}.pem`))).raw,
    x509SvidKey: readFileSync(path.join(directory, `${name}.der`)),
    bundle: new X509Certificate(readFileSync(path.join(directory, 'ca.pem'))).raw,
  }
}

beforeAll(async () => {
  openssl(
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
    '-days',
    '1',
    '-subj',
    '/CN=SPIFFE fixture CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
  )
  initial = makeSvid('initial', id)
  rotated = makeSvid('rotated', id)
  wrongIdentity = makeSvid('wrong', 'spiffe://galactic.proompteng.ai/ns/other/sa/other')
  server = new grpc.Server()
  const Constructor = descriptor.SpiffeWorkloadAPI
  if (typeof Constructor !== 'function' || !('service' in Constructor))
    throw new Error('Invalid Workload API descriptor')
  server.addService(Constructor.service as grpc.ServiceDefinition, {
    FetchX509SVID(call: grpc.ServerWritableStream<object, object>) {
      expect(call.metadata.get('workload.spiffe.io')).toEqual(['true'])
      calls.add(call)
      call.on('cancelled', () => calls.delete(call))
      call.write({ svids: [initial] })
    },
  })
  const endpoint = `unix://${directory}/api.sock`
  await new Promise<void>((resolve, reject) =>
    server.bindAsync(endpoint, grpc.ServerCredentials.createInsecure(), (error) => (error ? reject(error) : resolve())),
  )
  source = new SpiffeSource({ endpoint, spiffeId: id, protoPath })
})

afterAll(() => {
  source?.close()
  server?.forceShutdown()
  rmSync(directory, { recursive: true, force: true })
})

describe('SPIFFE Workload API', () => {
  test('uses the private socket and consumes the matching identity', async () => {
    const material = await source.material()
    expect(new X509Certificate(material.certificate).subjectAltName).toBe(`URI:${id}`)
    expect(material.bundle.toString()).toContain('BEGIN CERTIFICATE')
  })

  test('renews material on the same stream without restarting the source', async () => {
    const first = await source.material()
    for (const call of calls) call.write({ svids: [rotated] })
    const deadline = Date.now() + 2_000
    let material = await source.material()
    while (material.fingerprint === first.fingerprint && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      material = await source.material()
    }
    expect(material.fingerprint).not.toBe(first.fingerprint)
    expect(new X509Certificate(material.certificate).raw).toEqual(rotated.x509Svid)
  })

  test('rejects network Workload API addresses', () => {
    expect(() => new SpiffeSource({ endpoint: '127.0.0.1:8081', spiffeId: id, protoPath })).toThrow('Unix socket')
  })
})

describe('SPIFFE material validation', () => {
  test('rejects a claimed identity that differs from the certificate', () => {
    expect(() => parseSpiffeMaterial({ svids: [{ ...wrongIdentity, spiffeId: id }] }, id)).toThrow('identity')
    expect(() => parseSpiffeMaterial({ svids: [wrongIdentity] }, id)).toThrow('configured workload identity')
  })

  test('rejects expired certificates and mismatched private keys', () => {
    expect(() => parseSpiffeMaterial({ svids: [initial] }, id, Date.now() + 2 * 86_400_000)).toThrow('validity window')
    expect(() => parseSpiffeMaterial({ svids: [{ ...initial, x509SvidKey: rotated.x509SvidKey }] }, id)).toThrow(
      'private key',
    )
  })

  test('rejects truncated DER and unsupported revocation updates', () => {
    expect(() =>
      parseSpiffeMaterial({ svids: [{ ...initial, x509Svid: initial.x509Svid.subarray(0, 4) }] }, id),
    ).toThrow()
    expect(() => parseSpiffeMaterial({ svids: [initial], crl: [Buffer.from('crl')] }, id)).toThrow()
  })

  test('pins the peer URI and rejects malformed SPIFFE IDs', () => {
    expect(verifySpiffePeer(id, { subjectaltname: `URI:${id}` })).toBeUndefined()
    expect(verifySpiffePeer(id, { subjectaltname: `URI:${wrongIdentity.spiffeId}` })).toBeInstanceOf(Error)
    for (const value of [
      'https://example.org/identity',
      `${id}?query`,
      'spiffe://example.org/a/../b',
      'spiffe://example.org/a//b',
    ]) {
      expect(() => parseSpiffeId(value)).toThrow()
    }
  })
})
