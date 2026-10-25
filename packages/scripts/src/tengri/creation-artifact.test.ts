import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dir, '../../../..')

test('retains prepared creation counters when the native fixture fails', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'tengri-creation-artifact-'))
  try {
    writeFileSync(resolve(directory, 'ca.crt'), 'disposable-ca')
    writeFileSync(resolve(directory, 'runtime.password'), 'disposable-password')
    writeFileSync(resolve(directory, 'ip'), '#!/bin/sh\nprintf "1.1.1.1 dev fixture0\\n"\n', { mode: 0o755 })
    writeFileSync(resolve(directory, 'cat'), '#!/bin/sh\nprintf "1500\\n"\n', { mode: 0o755 })
    writeFileSync(
      resolve(directory, 'docker'),
      `#!/bin/sh
if [ "$1" = run ]; then
  for argument do
    if [ "$argument" = -i ]; then /bin/cat >/dev/null; fi
    if [ "$argument" = --name ]; then exit 17; fi
  done
fi
if [ "$1" = cp ]; then
  case "$2" in
    *:/work/creation-resources.json) printf '{"createMs":2483,"before":{},"after":{}}\\n' > "$3" ;;
  esac
fi
exit 0
`,
      { mode: 0o755 },
    )
    const result = Bun.spawnSync(['bash', resolve(repositoryRoot, 'services/tengri/test-kvm.sh')], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        TENGRI_KVM_TEST_IMAGE: 'private-fixture',
        TENGRI_KVM_GUEST_IMAGE: 'private-guest',
        TENGRI_KVM_NETWORK: 'disposable-network',
        TENGRI_KVM_DATABASE_HOST: 'disposable-database',
        TENGRI_DATABASE_CA_FILE: resolve(directory, 'ca.crt'),
        TENGRI_DATABASE_PASSWORD_FILE: resolve(directory, 'runtime.password'),
        TENGRI_KVM_OUTPUT: directory,
        TENGRI_KVM_SAMPLES: '3',
        TENGRI_KVM_SECCOMP: resolve(repositoryRoot, 'devices/galactic/omni/tengri-runner-amd64.json'),
      },
    })
    expect(result.exitCode).toBe(17)
    expect(JSON.parse(readFileSync(resolve(directory, 'creation-resources.json'), 'utf8'))).toEqual({
      createMs: 2483,
      before: {},
      after: {},
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
