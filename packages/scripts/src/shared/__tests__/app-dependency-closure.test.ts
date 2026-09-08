import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'bun:test'

const script = fileURLToPath(new URL('../../../../../nix/check-app-dependency-closure.sh', import.meta.url))
const drv = '/nix/store/00000000000000000000000000000000-app-bun-deps-0.drv'
const dependency = { env: { name: 'app-bun-deps-0' }, outputs: { out: {} } }

describe('App fixed-output dependency verification', () => {
  it.each([
    {
      name: 'realizes then rebuilds the selected Nix 2.28 output',
      entries: { [drv]: dependency },
      realize: 0,
      rebuild: 0,
      code: 0,
      builds: 2,
    },
    {
      name: 'accepts Nix 2.34 version 4 with store-relative keys',
      entries: {
        version: 4,
        derivations: { [drv.replace('/nix/store/', '')]: { ...dependency, name: 'app-bun-deps-0', version: 4 } },
      },
      realize: 0,
      rebuild: 0,
      code: 0,
      builds: 2,
    },
    { name: 'rejects an absent dependency', entries: {}, realize: 0, rebuild: 0, code: 1, builds: 0 },
    {
      name: 'rejects ambiguous dependencies',
      entries: { [drv]: dependency, [`${drv}-other`]: dependency },
      realize: 0,
      rebuild: 0,
      code: 1,
      builds: 0,
    },
    {
      name: 'rejects an unexpected output',
      entries: { [drv]: { ...dependency, outputs: { dev: {} } } },
      realize: 0,
      rebuild: 0,
      code: 1,
      builds: 0,
    },
    {
      name: 'stops on realization failure',
      entries: { [drv]: dependency },
      realize: 42,
      rebuild: 0,
      code: 42,
      builds: 1,
    },
    {
      name: 'preserves a forced rebuild hash failure',
      entries: { [drv]: dependency },
      realize: 0,
      rebuild: 43,
      code: 43,
      builds: 2,
    },
    {
      name: 'preserves a timeout failure',
      entries: { [drv]: dependency },
      realize: 0,
      rebuild: 124,
      code: 124,
      builds: 2,
    },
  ])('$name', ({ entries, realize, rebuild, code, builds }) => {
    const fixture = mkdtempSync(join(tmpdir(), 'app-fod-test-'))
    try {
      writeFileSync(join(fixture, 'derivations.json'), JSON.stringify(entries))
      writeFileSync(join(fixture, 'calls'), '')
      writeFileSync(
        join(fixture, 'nix'),
        `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  derivation) cat "$MOCK_DERIVATIONS" ;;
  build)
    printf '%s\\n' "$*" >> "$MOCK_CALLS"
    for arg in "$@"; do
      if [[ "$arg" == --rebuild ]]; then exit "$MOCK_REBUILD_EXIT"; fi
    done
    exit "$MOCK_REALIZE_EXIT"
    ;;
  *) exit 2 ;;
esac
`,
        { mode: 0o755 },
      )
      writeFileSync(join(fixture, 'timeout'), '#!/usr/bin/env bash\nset -euo pipefail\nshift 2\nexec "$@"\n', {
        mode: 0o755,
      })
      const result = Bun.spawnSync(['bash', script, 'x86_64-linux'], {
        env: {
          ...process.env,
          PATH: `${fixture}:${process.env.PATH}`,
          MOCK_DERIVATIONS: join(fixture, 'derivations.json'),
          MOCK_CALLS: join(fixture, 'calls'),
          MOCK_REALIZE_EXIT: String(realize),
          MOCK_REBUILD_EXIT: String(rebuild),
        },
      })
      expect(result.exitCode).toBe(code)
      const calls = readFileSync(join(fixture, 'calls'), 'utf8').trim().split('\n').filter(Boolean)
      expect(calls).toHaveLength(builds)
      if (builds > 0) expect(calls[0]).toBe(`build ${drv}^out --no-link --print-build-logs`)
      if (builds > 1) expect(calls[1]).toBe(`build ${drv}^out --rebuild --no-link --print-build-logs`)
      expect(result.stdout.toString().includes('dependency closure verified')).toBe(code === 0)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
