import { expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const browserFixture = resolve(import.meta.dir, '../../../../services/nanoagent/test-vscode-browser.sh')

function prepareBrowser({ mtu, networkCreationExit = 0 }: { mtu: string; networkCreationExit?: number }) {
  const fixture = mkdtempSync(resolve(tmpdir(), 'tengri-browser-network-'))
  try {
    mkdirSync(resolve(fixture, 'root.fixture'))
    const stub = (name: string, body: string) =>
      writeFileSync(resolve(fixture, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    stub('mktemp', 'printf "%s/root.fixture\\n" "$FIXTURE_DIRECTORY"')
    stub('uname', 'echo Linux')
    stub('ip', 'echo "1.1.1.1 via 192.0.2.1 dev eth0 src 192.0.2.2"')
    stub('cat', 'case "$1" in /sys/class/net/eth0/mtu) printf "%s\\n" "$FIXTURE_MTU";; *) exec /bin/cat "$@";; esac')
    for (const name of ['openssl', 'python3', 'node', 'go', 'curl']) stub(name, 'exit 0')
    stub(
      'docker',
      `printf '%s\\n' "$*" >> "$FIXTURE_DIRECTORY/docker.log"
case "$1 $2" in
  'image inspect') case "$*" in *Architecture*) echo amd64;; *) echo false;; esac;;
  'network create') echo owned-browser-network-id; exit "$FIXTURE_NETWORK_CREATION_EXIT";;
  'create --name') exit 42;;
esac`,
    )
    const result = Bun.spawnSync(['bash', browserFixture], {
      env: {
        ...process.env,
        PATH: `${fixture}:${process.env.PATH}`,
        TENGRI_BROWSER_TEST_IMAGE: 'fixture-image',
        FIXTURE_DIRECTORY: fixture,
        FIXTURE_MTU: mtu,
        FIXTURE_NETWORK_CREATION_EXIT: String(networkCreationExit),
      },
    })
    return { exitCode: result.exitCode, docker: readFileSync(resolve(fixture, 'docker.log'), 'utf8') }
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

it.each(['1400', '1500'])('uses the execution MTU %s on an owned browser network and cleans it up', (mtu) => {
  const result = prepareBrowser({ mtu })
  expect(result.exitCode).toBe(42)
  expect(result.docker).toContain(
    `network create --driver bridge --opt com.docker.network.driver.mtu=${mtu} tengri-browser-fixture-network\n`,
  )
  const create = result.docker.split('\n').find((line) => line.startsWith('create --name'))
  expect(create).toContain('--network owned-browser-network-id')
  expect(create).not.toContain('--cap-add NET_ADMIN')
  expect(create).not.toContain('--network host')
  expect(result.docker).toContain('network rm owned-browser-network-id\n')
  expect(result.docker.indexOf('rm tengri-browser-fixture\n')).toBeLessThan(
    result.docker.indexOf('network rm owned-browser-network-id\n'),
  )
})

it('does not remove a network when creation fails', () => {
  const result = prepareBrowser({ mtu: '1400', networkCreationExit: 17 })
  expect(result.exitCode).toBe(17)
  expect(result.docker).toContain('network create')
  expect(result.docker).not.toContain('network rm')
  expect(result.docker).not.toContain('create --name')
})

it.each(['', '0', '575', '65536', 'invalid'])('rejects browser MTU %s before creating network or container', (mtu) => {
  const result = prepareBrowser({ mtu })
  expect(result.exitCode).not.toBe(0)
  expect(result.docker).not.toContain('network create')
  expect(result.docker).not.toContain('create --name')
})
