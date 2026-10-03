import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { parseAllDocuments } from 'yaml'
import { sanitizeAuditPayload } from './audit'
import {
  isSecretRead,
  maskKubernetesSecretCreationArgs,
  maskKubernetesSecretCreationCommand,
  maskKubernetesSecretText,
  secretCaptureMode,
  SECRET_DOCUMENT_BYTE_BUDGET,
} from './kubernetes-secret-masker'
import { OutputAudit } from './output-audit'

const marker = '[REDACTED_CREDENTIAL]'
const secret = '{"data":{"registry":"c3ludGhldGljLWNyZWRlbnRpYWw="},"metadata":{"name":"fixture"},"kind":"Secret"}'

describe('Kubernetes Secret creation literals', () => {
  it.each([
    'kubectl create secret docker-registry regcred --docker-password=opaque-runtime-secret --docker-username=user',
    "kubectl create secret docker-registry regcred --docker-password 'opaque-runtime-secret' --docker-server=registry.example",
    'env KUBECONFIG=/dev/null kubectl -n agents create secret docker-registry regcred --docker-password=opaque-runtime-secret',
  ])('masks explicit Docker registry password source in %s', (command) => {
    const masked = maskKubernetesSecretCreationCommand(command)
    expect(masked.text).toBe(command.replace('opaque-runtime-secret', marker))
    expect(masked.values).toEqual(['opaque-runtime-secret'])
  })

  it('collects attached/separate Docker passwords with bounded decoded argv/source values', () => {
    const args = [
      'create',
      'secret',
      'docker-registry',
      'regcred',
      '--docker-password',
      'left;right=tail',
      '--docker-username=user',
    ]
    expect(maskKubernetesSecretCreationArgs(args)).toEqual({
      args: ['create', 'secret', 'docker-registry', 'regcred', '--docker-password', marker, '--docker-username=user'],
      values: ['left;right=tail'],
      maskedValues: 1,
    })
    expect(
      maskKubernetesSecretCreationArgs([
        'create',
        'secret',
        'docker-registry',
        'regcred',
        '--docker-password=left=right',
      ]).args.at(-1),
    ).toBe(`--docker-password=${marker}`)
    const command = 'kubectl create secret docker-registry regcred --docker-password=\'left\'" right"'
    expect(maskKubernetesSecretCreationCommand(command).values).toEqual(['left right'])
    expect(maskKubernetesSecretCreationCommand(command).text).not.toContain('left')
    expect(() =>
      maskKubernetesSecretCreationCommand('kubectl create secret docker-registry regcred --docker-password=$PASSWORD'),
    ).toThrow()
    expect(() =>
      maskKubernetesSecretCreationArgs([
        'create',
        'secret',
        'docker-registry',
        'regcred',
        `--docker-password=${'x'.repeat(4097)}`,
      ]),
    ).toThrow()
  })

  it.each([
    'kubectl create secret generic demo --from-literal=registry=opaque-runtime-secret',
    "kubectl create secret generic demo --from-literal 'registry=opaque-runtime-secret'",
    'KUBECONFIG=/tmp/config kubectl create secret generic demo --from-literal=registry=opaque-runtime-secret',
    'env -i KUBECONFIG=/tmp/config /usr/bin/kubectl -n agents create secret generic demo --from-literal=registry=opaque-runtime-secret',
    'kubectl --context context -v 8 create --namespace agents secret generic demo --from-literal=registry=opaque-runtime-secret',
    'kubectl --v 8 create secret generic demo --from-literal=registry=opaque-runtime-secret',
    'kubectl create secret generic demo \\\n --from-literal=registry=opaque-runtime-secret',
    "kubectl create secret generic demo --from-literal='registry=opaque-runtime-secret' --dry-run=client -o json",
  ])('masks only the literal value in %s', (command) => {
    const masked = maskKubernetesSecretCreationCommand(command)
    expect(masked.text).toBe(command.replace('opaque-runtime-secret', marker))
    expect(masked.values).toEqual(['opaque-runtime-secret'])
    expect(masked.maskedValues).toBe(1)
  })

  it.each([
    ["'registry=left right=tail'", 'left right=tail'],
    ['registry=left\\ right\\;tail', 'left right;tail'],
    ['registry=\'left\'" right"', 'left right'],
    ['registry="left\\q\\$right"', 'left\\q$right'],
    ["registry='left'\\''right'", "left'right"],
    ['registry=left\\\nright', 'leftright'],
    ["registry='left;right|tail&last'", 'left;right|tail&last'],
  ])('decodes quoted/escaped literal %s without evaluating source', (argument, value) => {
    const masked = maskKubernetesSecretCreationCommand(`kubectl create secret generic demo --from-literal ${argument}`)
    expect(masked.values).toEqual([value])
    expect(masked.text).toContain(`registry=`)
    expect(masked.text).toContain(marker)
    expect(masked.text).not.toContain('left')
    expect(masked.text).not.toContain('right')
  })

  it.each([
    'kubectl create configmap secret --from-literal=registry=ordinary',
    'kubectl create configmap demo --from-literal registry=ordinary',
    "echo 'kubectl create secret generic demo --from-literal=registry=ordinary'",
    'kubectl --context create configmap secret --from-literal=registry=ordinary',
  ])('preserves ordinary literals/source in %s', (command) => {
    expect(maskKubernetesSecretCreationCommand(command)).toEqual({ text: command, values: [], maskedValues: 0 })
  })

  it('masks attached/separate argv operands and preserves command/resource/key names', () => {
    const args = [
      'create',
      'secret',
      'generic',
      'demo',
      '--from-literal=registry=demo',
      '--from-literal',
      'another=left;right=tail',
    ]
    expect(maskKubernetesSecretCreationArgs(args)).toEqual({
      args: [
        'create',
        'secret',
        'generic',
        'demo',
        `--from-literal=registry=${marker}`,
        '--from-literal',
        `another=${marker}`,
      ],
      values: ['demo', 'left;right=tail'],
      maskedValues: 2,
    })
    expect(args[4]).toBe('--from-literal=registry=demo')
    const ordinary = ['create', 'configmap', 'secret', '--from-literal=registry=ordinary']
    expect(maskKubernetesSecretCreationArgs(ordinary).args).toEqual(ordinary)
  })

  it('masks actual literal echo arguments while preserving creation identifiers with the same text', () => {
    const command = "kubectl create secret generic demo --from-literal=registry=demo; printf '%s\\n' 'demo'"
    expect(maskKubernetesSecretCreationCommand(command).text).toBe(
      `kubectl create secret generic demo --from-literal=registry=${marker}; printf '%s\\n' '${marker}'`,
    )
    const escaped = "kubectl create secret generic demo --from-literal=registry='left right'; printf '%s' left\\ right"
    expect(maskKubernetesSecretCreationCommand(escaped).text).toBe(
      `kubectl create secret generic demo --from-literal=registry='${marker}'; printf '%s' ${marker}`,
    )
  })

  it('fails closed after recognizing dynamic, ambiguous or oversized literal contexts', () => {
    for (const argument of ['registry=$VALUE', "registry='unterminated", `registry=${'x'.repeat(4097)}`])
      expect(() =>
        maskKubernetesSecretCreationCommand(`kubectl create secret generic demo --from-literal=${argument}`),
      ).toThrow()
    expect(() =>
      maskKubernetesSecretCreationCommand(
        `kubectl create secret generic demo ${'arg '.repeat(260)} --from-literal=registry=tail`,
      ),
    ).toThrow()
    expect(() =>
      maskKubernetesSecretCreationArgs([
        'create',
        'secret',
        'generic',
        'demo',
        `--from-literal=registry=${'x'.repeat(4097)}`,
      ]),
    ).toThrow()
    expect(() =>
      maskKubernetesSecretCreationCommand(
        `kubectl create secret generic demo --from-literal=registry=abcd${'; echo abcd'.repeat(256)}`,
      ),
    ).toThrow('span capture')
  })
})

describe('qualified Secret resources and structured creation output', () => {
  it.each(['secrets.v1./demo', 'secret.v1.', 'secrets./demo', 'secret.v1./demo,pods'])(
    'recognizes qualified resource %s',
    (resource) => {
      expect(secretCaptureMode(`kubectl get ${resource}`)).toBe('metadata')
      expect(secretCaptureMode(`kubectl get ${resource} -ojson`)).toBe('document')
      expect(secretCaptureMode(`KUBECONFIG=/dev/null kubectl get ${resource} -oyaml`)).toBe('document')
      expect(secretCaptureMode(`kubectl get ${resource} -o jsonpath='{.data.registry}'`)).toBe('projection')
    },
  )

  it.each(['generic', 'docker-registry', 'tls'])('captures known Secret create %s documents structurally', (kind) => {
    const command = `kubectl create secret ${kind} demo --dry-run=client`
    expect(secretCaptureMode(command)).toBe('metadata')
    expect(secretCaptureMode(`${command} -ojson`)).toBe('document')
    expect(secretCaptureMode(`${command} --output=yaml`)).toBe('document')
    expect(secretCaptureMode(`${command} -o jsonpath='{.data.*}'`)).toBe('projection')
  })

  it('keeps ConfigMap resource names and creation literals ordinary', () => {
    expect(secretCaptureMode('kubectl get configmaps.v1./secrets -ojson')).toBeNull()
    expect(secretCaptureMode('kubectl create configmap secret --from-literal=registry=ordinary -ojson')).toBeNull()
    expect(
      maskKubernetesSecretCreationArgs(['create', 'configmap', 'secret', '--from-literal=registry=ordinary']).values,
    ).toEqual([])
  })

  it.each(['json', 'yaml'])(
    'masks complete Docker configuration blobs in both %s streams and result duplicates',
    (format) => {
      const encoded = Buffer.from(
        JSON.stringify({
          auths: {
            registry: {
              username: 'user',
              password: 'opaque-runtime-secret',
              auth: Buffer.from('user:opaque-runtime-secret').toString('base64'),
            },
          },
        }),
      ).toString('base64')
      const document =
        format === 'json'
          ? JSON.stringify({
              apiVersion: 'v1',
              kind: 'Secret',
              metadata: { name: 'regcred' },
              data: { '.dockerconfigjson': encoded },
            })
          : `apiVersion: v1\nkind: Secret\nmetadata:\n  name: regcred\ndata:\n  .dockerconfigjson: ${encoded}\n`
      const command = `kubectl create secret docker-registry regcred --docker-password opaque-runtime-secret -o${format}`
      for (const stream of ['stdout', 'stderr']) {
        const events: Record<string, unknown>[] = []
        const mirror = new OutputAudit(
          stream === 'stdout' ? 'stdout' : 'stderr',
          (_event, payload) => {
            events.push(payload)
            return 0
          },
          secretCaptureMode(command),
        )
        const source = new PassThrough()
        const failed = vi.fn()
        for (let offset = 0; offset < document.length; offset += 3)
          mirror.write(Buffer.from(document.slice(offset, offset + 3)), source, failed)
        mirror.finish()
        expect(JSON.stringify(events)).not.toContain(encoded)
        expect(JSON.stringify(events)).toContain(marker)
        expect(failed).not.toHaveBeenCalled()
        expect(sanitizeAuditPayload({ result: { command, [stream]: document } }).payload).toMatchObject({
          result: { [stream]: document.replace(encoded, format === 'json' ? marker : `"${marker}"`) },
        })
      }
    },
  )
})

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

describe('explicit Secret reads with environment prefixes', () => {
  it.each([
    'KUBECONFIG=/tmp/config',
    "KUBECONFIG='/tmp/config with spaces' LANG=C",
    'KUBECONFIG="/tmp/config; ordinary -o jsonpath"',
    'env KUBECONFIG=/tmp/config',
    'env - KUBECONFIG=/tmp/config',
    "env 'KUBECONFIG=/tmp/config with spaces'",
    'LANG=C /usr/bin/env -i --unset HOME --chdir /workspace KUBECONFIG=/tmp/config --',
    'env --ignore-environment -uHOME -C/workspace KUBECONFIG=/tmp/config',
    "env --unset=HOME --chdir='/workspace with spaces' KUBECONFIG=/tmp/config",
  ])('preserves capture modes for %s', (prefix) => {
    expect(secretCaptureMode(`${prefix} kubectl get secret demo`)).toBe('metadata')
    expect(secretCaptureMode(`${prefix} kubectl get secret demo -o json`)).toBe('document')
    expect(secretCaptureMode(`${prefix} '/usr/bin/kubectl' -n agents get secrets/demo --output='yaml'`)).toBe(
      'document',
    )
    expect(secretCaptureMode(`${prefix} kubectl get secret demo -o jsonpath='{.data.registry}'`)).toBe('projection')
    expect(secretCaptureMode(`${prefix} kubectl get secrets --template='{{.data.registry}}'`)).toBe('projection')
    expect(secretCaptureMode(`${prefix} kubectl get configmap demo -o json`)).toBe(null)
  })

  it('omits prefixed bare projections from both streams and duplicate results', () => {
    for (const prefix of ['KUBECONFIG=/tmp/config', 'env KUBECONFIG=/tmp/config']) {
      const command = `${prefix} kubectl get secret demo -o jsonpath='{.data.registry}'`
      for (const stream of ['stdout', 'stderr'] as const) {
        const events: Array<Record<string, unknown>> = []
        const mirror = new OutputAudit(
          stream,
          (_event, payload) => {
            events.push(payload)
            return 0
          },
          secretCaptureMode(command),
        )
        mirror.write(Buffer.from('synthetic-projected-credential'), new PassThrough(), vi.fn())
        mirror.finish()
        expect(JSON.stringify(events)).not.toContain('synthetic-projected-credential')
        expect(events.at(-1)).toMatchObject({ captureIncomplete: true, capturedBytes: 0, sha256: null })
        expect(() => sanitizeAuditPayload({ result: { command, [stream]: 'synthetic-projected-credential' } })).toThrow(
          'projection',
        )
      }
    }
  })

  it('masks prefixed Secret document duplicates on stdout and stderr without changing the original', () => {
    const original = {
      command: 'env -i KUBECONFIG=/tmp/config kubectl get secret demo -o json',
      stdout: secret,
      stderr: secret,
    }
    expect(sanitizeAuditPayload({ result: original }).payload).toMatchObject({
      result: {
        stdout: secret.replace('c3ludGhldGljLWNyZWRlbnRpYWw=', marker),
        stderr: secret.replace('c3ludGhldGljLWNyZWRlbnRpYWw=', marker),
      },
    })
    expect(original.stdout).toBe(secret)
    expect(original.stderr).toBe(secret)
  })

  it.each([
    'echo "KUBECONFIG=/tmp/config kubectl get secret demo -o json"',
    "env KUBECONFIG=/tmp/config printf '%s\\n' 'kubectl get secret demo -o json'",
    'echo "ordinary; env KUBECONFIG=/tmp/config kubectl get secret demo -o json"',
    'python -c \'source = "env KUBECONFIG=/tmp/config kubectl get secret demo -o json"\'',
    "cat <<'EOF'\nenv KUBECONFIG=/tmp/config kubectl get secret demo -o json\nEOF",
    "cat<<'EOF'\nenv KUBECONFIG=/tmp/config kubectl get secret demo -o json\nEOF",
    'KUBECONFIG=/tmp/config kubectl-example get secret demo -o json',
    "env -S 'kubectl get secret demo -o json'",
  ])('does not treat ordinary text or indirect wrappers as an explicit read: %s', (command) => {
    expect(isSecretRead(command)).toBe(false)
    expect(secretCaptureMode(command)).toBe(null)
  })

  it('recognizes prefixed commands after real separators and keeps later lexical ambiguity incomplete', () => {
    expect(
      secretCaptureMode(
        'echo "ordinary; kubectl get secret demo"; env KUBECONFIG=/tmp/config kubectl get secret demo -o json',
      ),
    ).toBe('document')
    expect(secretCaptureMode('KUBECONFIG=/tmp/config \\\n kubectl get secret demo -o yaml')).toBe('document')
    expect(secretCaptureMode(`kubectl get secret demo -o json ${'argument '.repeat(300)}`)).toBe('projection')
    expect(secretCaptureMode(`kubectl get secret demo -o json ${'x'.repeat(4097)}`)).toBe('projection')
    expect(secretCaptureMode('kubectl get secret demo -o "json')).toBe('projection')
  })

  it('retains the executable after more assignment prefixes than the retained argument cap', () => {
    const assignments = Array.from({ length: 300 }, (_, index) => `PREFIX_${index}=ordinary`).join(' ')
    for (const prefix of [assignments, `env -i --unset HOME ${assignments}`, `${assignments} env -- ${assignments}`]) {
      expect(secretCaptureMode(`${prefix} kubectl get secret demo -o json`)).toBe('document')
      expect(secretCaptureMode(`${prefix} kubectl get secret demo -o jsonpath='{.data.registry}'`)).toBe('projection')
      expect(secretCaptureMode(`${prefix} echo 'kubectl get secret demo -o json'`)).toBe(null)
    }
  })
})

describe('literal Secret API reads through kubectl get --raw', () => {
  it.each([
    'kubectl get --raw=/api/v1/namespaces/agents/secrets/demo',
    "kubectl get --raw '/api/v1/namespaces/agents/secrets/demo'",
    'KUBECONFIG=/tmp/config kubectl get --raw=/api/v1/namespaces/agents/secrets',
    "env KUBECONFIG=/tmp/config kubectl get '--raw' '/api/v1/secrets?pretty=true'",
    'kubectl get --raw=/api/v1/namespaces/agents/secrets/demo/ -o name',
  ])('structurally masks both streams and duplicate results for %s', (command) => {
    expect(secretCaptureMode(command)).toBe('document')
    expect(isSecretRead(command)).toBe(true)
    for (const stream of ['stdout', 'stderr'] as const) {
      const events: Array<{ event: string; payload: Record<string, unknown> }> = []
      const mirror = new OutputAudit(
        stream,
        (event, payload) => {
          events.push({ event, payload })
          return 0
        },
        secretCaptureMode(command),
      )
      mirror.write(Buffer.from(secret.slice(0, 40)), new PassThrough(), vi.fn())
      mirror.write(Buffer.from(secret.slice(40)), new PassThrough(), vi.fn())
      expect(events).toHaveLength(0)
      mirror.finish()
      expect(
        events
          .filter((entry) => entry.event === 'process_output')
          .map((entry) => entry.payload.text)
          .join(''),
      ).toBe(secret.replace('c3ludGhldGljLWNyZWRlbnRpYWw=', marker))
      expect(events.at(-1)?.payload).toMatchObject({ maskedValues: 1, captureIncomplete: false, sha256: null })
      const original = { command, [stream]: secret }
      expect(sanitizeAuditPayload({ result: original }).payload).toMatchObject({
        result: { [stream]: secret.replace('c3ludGhldGljLWNyZWRlbnRpYWw=', marker) },
      })
      expect(original[stream]).toBe(secret)
    }
  })

  it('does not classify unrelated raw endpoints or quoted source as Secret API reads', () => {
    for (const command of [
      'kubectl get --raw=/api/v1/namespaces/agents/configmaps/secrets',
      'kubectl get --raw=/api/v1/namespaces/agents/secretreferences/demo',
      "echo 'kubectl get --raw=/api/v1/namespaces/agents/secrets/demo'",
    ])
      expect(secretCaptureMode(command)).toBe(null)
  })
})
