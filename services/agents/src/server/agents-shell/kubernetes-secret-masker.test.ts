import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { parseAllDocuments } from 'yaml'
import { sanitizeAuditPayload } from './audit'
import {
  isSecretRead,
  maskKubernetesSecretText,
  secretCaptureMode,
  SECRET_DOCUMENT_BYTE_BUDGET,
} from './kubernetes-secret-masker'
import { OutputAudit } from './output-audit'

const marker = '[REDACTED_CREDENTIAL]'
const secret = '{"data":{"registry":"c3ludGhldGljLWNyZWRlbnRpYWw="},"metadata":{"name":"fixture"},"kind":"Secret"}'

describe('known Kubernetes Secret containers', () => {
  it('preserves JSON formatting/metadata/key names when kind follows credential data', () => {
    const masked = maskKubernetesSecretText(secret)
    expect(masked.text).toBe(secret.replace('c3ludGhldGljLWNyZWRlbnRpYWw=', marker))
    expect(masked.maskedValues).toBe(1)
  })
  it('retains multi-document YAML and ConfigMap content while masking only Secret values', () => {
    const input =
      'kind: ConfigMap\ndata:\n  registry: ordinary\n---\nkind: Secret\nmetadata:\n  name: fixture\nstringData:\n  registry: |\n    synthetic-credential\n  other: second-credential\n'
    const masked = maskKubernetesSecretText(input, 'document')
    expect(masked.text).toContain('kind: ConfigMap\ndata:\n  registry: ordinary\n')
    expect(masked.text).toContain('metadata:\n  name: fixture\n')
    expect(masked.text).not.toContain('synthetic-credential')
    expect(masked.text).not.toContain('second-credential')
    const docs = parseAllDocuments(masked.text)
    expect(docs.every((doc) => doc.errors.length === 0)).toBe(true)
    expect(docs[1].toJSON()).toMatchObject({ stringData: { registry: marker, other: marker } })
  })
  it('handles SecretList and scalar malformed credential containers without redacting lookalikes', () => {
    const list = { kind: 'SecretList', items: [{ metadata: { name: 'a' }, data: { arbitrary: 'synthetic' } }] }
    expect(JSON.parse(maskKubernetesSecretText(JSON.stringify(list)).text).items[0].data.arbitrary).toBe(marker)
    expect(sanitizeAuditPayload(list).payload).toMatchObject({ items: [{ data: { arbitrary: marker } }] })
    for (const data of ['synthetic', ['synthetic'], { arbitrary: 'synthetic' }]) {
      const result = maskKubernetesSecretText(JSON.stringify({ kind: 'Secret', data })).text
      expect(result).not.toContain('synthetic')
    }
    for (const kind of ['ConfigMap', 'SecretReference', 'NotSecret']) {
      const text = JSON.stringify({ kind, data: { ordinary: 'visible' } })
      expect(maskKubernetesSecretText(text).text).toBe(text)
    }
    expect(maskKubernetesSecretText('{"kind":"Secret","data":null}').text).toBe('{"kind":"Secret","data":null}')
  })
  it('rejects malformed recognized output, aliases and bounded depth/size without expansion', () => {
    expect(() => maskKubernetesSecretText('{"kind":"Secret",', 'document')).toThrow('parsed')
    expect(() =>
      maskKubernetesSecretText('kind: Secret\nstringData:\n  a: &x synthetic\n  b: *x\n', 'document'),
    ).toThrow('aliases')
    expect(() => maskKubernetesSecretText('kind: Secret\ndata: [' + '0,'.repeat(70_000) + '0]', 'document')).toThrow(
      'token budget',
    )
    expect(() => maskKubernetesSecretText('x'.repeat(SECRET_DOCUMENT_BYTE_BUDGET + 1), 'document')).toThrow(
      'byte budget',
    )
    expect(() =>
      maskKubernetesSecretText('kind: Secret\nmetadata: ' + '['.repeat(70) + '0' + ']'.repeat(70), 'document'),
    ).toThrow('structure budget')
  })
  it('masks bare Secret projections but retains default metadata tables', () => {
    expect(() => maskKubernetesSecretText('synthetic-base64-value\n', 'document')).toThrow('resource kind')
    const table = 'NAME TYPE DATA AGE\nfixture Opaque 1 3d\n'
    expect(maskKubernetesSecretText(table, 'metadata').text).toBe(table)
    expect(() =>
      maskKubernetesSecretText(table.replace('fixture Opaque 1', 'fixture Opaque synthetic-secret'), 'projection'),
    ).toThrow('projection')
    expect(secretCaptureMode('kubectl get secrets')).toBe('metadata')
    expect(
      secretCaptureMode('kubectl get secret foo -o custom-columns=NAME:.metadata.name,TYPE:.type,DATA:.data.registry'),
    ).toBe('projection')
    expect(isSecretRead('kubectl -n agents get secrets/foo -o json')).toBe(true)
    expect(isSecretRead('kubectl get configmap foo -o yaml')).toBe(false)
  })
  it('holds every split of credential output until structurally masked and leaves original response intact', () => {
    for (let split = 0; split <= secret.length; split += 1) {
      const events: Array<{ event: string; payload: Record<string, unknown> }> = []
      const mirror = new OutputAudit(
        'stdout',
        (event, payload) => {
          events.push({ event, payload })
          return 0
        },
        'document',
      )
      const source = new PassThrough()
      const failed = vi.fn()
      mirror.write(Buffer.from(secret.slice(0, split)), source, failed)
      mirror.write(Buffer.from(secret.slice(split)), source, failed)
      expect(events).toHaveLength(0)
      mirror.finish()
      expect(failed).not.toHaveBeenCalled()
      expect(
        events
          .filter((event) => event.event === 'process_output')
          .map((event) => event.payload.text)
          .join(''),
      ).toBe(secret.replace('c3ludGhldGljLWNyZWRlbnRpYWw=', marker))
      expect(events.at(-1)?.payload).toMatchObject({
        totalBytes: Buffer.byteLength(secret),
        capturedBytes: Buffer.byteLength(secret),
        sourceByteCheckpointOnly: true,
        maskedValues: 1,
        sha256: null,
        captureError: null,
      })
    }
    const original = { command: 'kubectl get secret fixture -o json', stdout: secret, stderr: '' }
    expect(sanitizeAuditPayload({ result: original }).payload).toMatchObject({
      result: {
        stdout: secret.replace('c3ludGhldGljLWNyZWRlbnRpYWw=', marker),
      },
    })
    expect(original.stdout).toBe(secret)
  })
  it('reports incomplete capture instead of exporting a malformed or over-budget Secret prefix', () => {
    const events: Array<Record<string, unknown>> = []
    const mirror = new OutputAudit(
      'stdout',
      (_event, payload) => {
        events.push(payload)
        return 0
      },
      'document',
    )
    const failure = vi.fn()
    mirror.write(Buffer.alloc(SECRET_DOCUMENT_BYTE_BUDGET + 1, 'x'), new PassThrough(), failure)
    mirror.finish()
    expect(failure).not.toHaveBeenCalled()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ capturedBytes: 0, sha256: null, sinkErrors: 1 })
    expect(events[0].captureError).toBeTruthy()
  })
})

it('normalizes escaped newlines and refuses arbitrary projections on either stream', () => {
  expect(secretCaptureMode('kubectl \\\n get secret demo -o yaml')).toBe('document')
  expect(secretCaptureMode('echo "kubectl get secret demo"')).toBe(null)
  for (const stream of ['stdout', 'stderr'] as const) {
    const events: Array<Record<string, unknown>> = []
    const mirror = new OutputAudit(
      stream,
      (_event, payload) => {
        events.push(payload)
        return 0
      },
      'projection',
    )
    mirror.write(
      Buffer.from('{"kind":"ConfigMap","data":{"note":"synthetic-projected-credential"}}'),
      new PassThrough(),
      vi.fn(),
    )
    mirror.finish()
    expect(JSON.stringify(events)).not.toContain('synthetic-projected-credential')
    expect(events.at(-1)).toMatchObject({ captureIncomplete: true, capturedBytes: 0, sha256: null })
  }
})

it('recognizes quoted and anchored YAML kinds and preserves ordinary stderr diagnostics', () => {
  for (const kind of ['"Secret"', "'Secret'", '&kind Secret']) {
    const text = `kind: ${kind}\ndata:\n  arbitrary: synthetic-credential\n`
    expect(maskKubernetesSecretText(text).text).not.toContain('synthetic-credential')
  }
  const error = 'Error from server (Forbidden): secrets "fixture" is forbidden\n'
  expect(maskKubernetesSecretText(error, 'document', true).text).toBe(error)
  expect(() => maskKubernetesSecretText(error, 'projection', true)).toThrow('projection')
})

it('treats dynamic, quoted and repeated unknown output flags as credential projections', () => {
  for (const suffix of [
    '-o "$FORMAT"',
    "'-o' '$FORMAT'",
    '--output=$FORMAT',
    '-o json -o "$FORMAT"',
    '-o "json"$SUFFIX',
  ])
    expect(secretCaptureMode(`kubectl get secret demo ${suffix}`)).toBe('projection')
  for (const suffix of ['-o json', "'-o' 'json'", '--output="yaml"'])
    expect(secretCaptureMode(`kubectl get secret demo ${suffix}`)).toBe('document')
})
