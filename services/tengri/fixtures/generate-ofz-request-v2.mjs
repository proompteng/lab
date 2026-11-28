import { createHash, createHmac } from 'node:crypto'
import { writeFileSync } from 'node:fs'
const vector = {
  keyHex: '6868686868686868686868686868686868686868686868686868686868686868',
  rpcPath: '/proompteng.runtime.v1.MicroVMControlPlane/GetAgent',
  bodyHex: '0a076167656e742d31',
  nonce: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  contextBase64:
    'CkIKQGFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWESJDExMTExMTExLTExMTEtNDExMS04MTExLTExMTExMTExMTExMSIkMjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIyKIj3lf+8MTIkMzMzMzMzMzMtMzMzMy00MzMzLTgzMzMtMzMzMzMzMzMzMzMzOiQ0NDQ0NDQ0NC00NDQ0LTQ0NDQtODQ0NC00NDQ0NDQ0NDQ0NDRCFWh0dHBzOi8vcHJvb21wdGVuZy5haUgB',
  recoveryGeneration: '7',
  nowUnixMs: 1700000000000,
  audience: '77777777-7777-4777-8777-777777777777',
}
const payload = [
  'tengri.ofz.v2',
  vector.audience,
  vector.rpcPath,
  createHash('sha256').update(Buffer.from(vector.bodyHex, 'hex')).digest('hex'),
  vector.nonce,
  Buffer.from(vector.contextBase64, 'base64').toString('base64url'),
  vector.recoveryGeneration,
].join('\n')
vector.signature = createHmac('sha256', Buffer.from(vector.keyHex, 'hex')).update(payload).digest('hex')
writeFileSync(new URL('./ofz-request-v2.json', import.meta.url), JSON.stringify(vector, null, 2) + '\n')
