import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const network = resolve(import.meta.dir, '../../../../services/tengri/network.sh')
const entry = resolve(import.meta.dir, '../../../../services/tengri/test-kvm-entry.sh')

function configureNetwork(mtu: string) {
  const fixture = mkdtempSync(resolve(tmpdir(), 'tengri-network-'))
  try {
    writeFileSync(
      resolve(fixture, 'cat'),
      '#!/bin/sh\ncase "$1" in /proc/sys/net/ipv4/ip_forward) echo 1;; /sys/class/net/eth0/mtu) printf "%s\\n" "$FIXTURE_MTU";; *) exec /bin/cat "$@";; esac\n',
      { mode: 0o755 },
    )
    writeFileSync(
      resolve(fixture, 'ip'),
      '#!/bin/sh\ncase "$*" in "-4 route show default") echo "default via 192.0.2.1 dev eth0";; "-4 route show") :;; *) printf "%s\\n" "$*" >> "$FIXTURE_DIRECTORY/links";; esac\n',
      { mode: 0o755 },
    )
    writeFileSync(resolve(fixture, 'nft'), '#!/bin/sh\n/bin/cat > "$FIXTURE_DIRECTORY/rules"\n', { mode: 0o755 })
    writeFileSync(resolve(fixture, 'resolv.conf'), 'nameserver 1.1.1.1\n')
    const script = readFileSync(network, 'utf8').replace('/etc/resolv.conf', '"$FIXTURE_DIRECTORY/resolv.conf"')
    const result = Bun.spawnSync(['sh', '-c', script], {
      env: { ...process.env, PATH: `${fixture}:${process.env.PATH}`, FIXTURE_MTU: mtu, FIXTURE_DIRECTORY: fixture },
    })
    const output = (name: string) =>
      existsSync(resolve(fixture, name)) ? readFileSync(resolve(fixture, name), 'utf8') : ''
    return { exitCode: result.exitCode, links: output('links'), rules: output('rules') }
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

function configureFixture(mtu: string) {
  const fixture = mkdtempSync(resolve(tmpdir(), 'tengri-fixture-mtu-'))
  try {
    writeFileSync(resolve(fixture, 'ip'), '#!/bin/sh\nprintf "%s\\n" "$*" > "$FIXTURE_DIRECTORY/links"\nexit 42\n', {
      mode: 0o755,
    })
    const result = Bun.spawnSync(['sh', entry], {
      env: {
        ...process.env,
        PATH: `${fixture}:${process.env.PATH}`,
        TENGRI_KVM_NETWORK_MTU: mtu,
        FIXTURE_DIRECTORY: fixture,
      },
    })
    const links = resolve(fixture, 'links')
    return { exitCode: result.exitCode, links: existsSync(links) ? readFileSync(links, 'utf8') : '' }
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

describe('Tengri guest network MTU', () => {
  it.each([
    { interfaceMtu: '1400', tapMtu: 1400, mss: 1360 },
    { interfaceMtu: '1500', tapMtu: 1500, mss: 1460 },
    { interfaceMtu: '9000', tapMtu: 1500, mss: 1460 },
  ])('bounds the TAP and both TCP directions for %p', ({ interfaceMtu, tapMtu, mss }) => {
    const result = configureNetwork(interfaceMtu)
    expect(result.exitCode).toBe(0)
    expect(result.links).toContain(`link set dev tengri0 mtu ${tapMtu} up`)
    for (const direction of ['iifname', 'oifname']) {
      expect(result.rules).toContain(
        `${direction} "tengri0" meta nfproto ipv4 tcp flags & (syn | rst) == syn tcp option maxseg size > ${mss} tcp option maxseg size set ${mss}`,
      )
    }
    expect(result.rules).toContain('ip daddr @protected drop')
    expect(result.rules).toContain('ip saddr != 10.250.0.2 drop')
    expect(result.rules).toContain('oifname "tengri0" ct state established,related accept')
    expect(result.rules).toContain('oifname "tengri0" drop')
  })

  it.each(['', '0', '575', '65536', 'invalid'])('rejects invalid MTU %s before configuring a guest network', (mtu) => {
    const result = configureNetwork(mtu)
    expect(result.exitCode).not.toBe(0)
    expect(result.links).toBe('')
    expect(result.rules).toBe('')
  })

  it('configures only the private fixture interface from the execution MTU', () => {
    const result = configureFixture('1400')
    expect(result.exitCode).toBe(42)
    expect(result.links).toBe('link set dev eth0 mtu 1400\n')
  })

  it.each(['', '0', '575', '65536', 'invalid'])('rejects invalid fixture MTU %s before interface setup', (mtu) => {
    const result = configureFixture(mtu)
    expect(result.exitCode).not.toBe(0)
    expect(result.links).toBe('')
  })
})
