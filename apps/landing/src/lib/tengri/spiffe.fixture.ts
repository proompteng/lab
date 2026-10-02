import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'

export async function createSpiffeFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'tengri-spiffe-'))
  const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: directory, stdio: 'ignore' })
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
  const bundle = readFileSync(path.join(directory, 'ca.pem'))
  const certificate = (name: string, spiffeId: string) => {
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
    const pem = readFileSync(path.join(directory, `${name}.pem`))
    const key = readFileSync(path.join(directory, `${name}.key`))
    return {
      pem,
      key,
      svid: {
        spiffeId,
        x509Svid: new X509Certificate(pem).raw,
        x509SvidKey: readFileSync(path.join(directory, `${name}.der`)),
        bundle: new X509Certificate(bundle).raw,
      },
    }
  }
  const ownId = 'spiffe://galactic.proompteng.ai/ns/proompteng/sa/proompteng'
  const peerId = 'spiffe://galactic.proompteng.ai/ns/tengri/sa/tengri'
  const own = certificate('bff', ownId)
  const peer = certificate('controller', peerId)
  let current = own.svid
  const calls = new Set<grpc.ServerWritableStream<object, object>>()
  const protoPath = path.resolve(import.meta.dir, '../../../../../services/tengri/proto/spiffe/workloadapi.proto')
  const descriptor = grpc.loadPackageDefinition(protoLoader.loadSync(protoPath, { defaults: true, keepCase: false }))
  const Constructor = descriptor.SpiffeWorkloadAPI
  if (typeof Constructor !== 'function' || !('service' in Constructor))
    throw new Error('Invalid Workload API descriptor')
  const server = new grpc.Server()
  server.addService(Constructor.service as grpc.ServiceDefinition, {
    FetchX509SVID(call: grpc.ServerWritableStream<object, object>) {
      if (call.metadata.get('workload.spiffe.io')[0] !== 'true') {
        call.destroy(new Error('missing Workload API metadata'))
        return
      }
      calls.add(call)
      call.on('cancelled', () => calls.delete(call))
      call.write({ svids: [current] })
    },
  })
  const endpoint = `unix://${directory}/api.sock`
  await new Promise<void>((resolve, reject) =>
    server.bindAsync(endpoint, grpc.ServerCredentials.createInsecure(), (error) => (error ? reject(error) : resolve())),
  )
  return {
    directory,
    endpoint,
    protoPath,
    ownId,
    peerId,
    own,
    peer,
    bundle,
    certificate,
    rotate() {
      current = certificate('bff-rotated', ownId).svid
      for (const call of calls) call.write({ svids: [current] })
    },
    close() {
      server.forceShutdown()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
