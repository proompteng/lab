import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { repoRoot } from '../cli'

const validator = join(repoRoot, '.github/scripts/validate-oci-mirror-inputs.sh')
const digest = `sha256:${'a'.repeat(64)}`

const validate = (overrides: Readonly<Record<string, string>> = {}) =>
  spawnSync('bash', [validator], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SOURCE_REPOSITORY: 'proompteng/tigresse',
      SOURCE_DIGEST: digest,
      TARGET_REPOSITORY: 'tigresse',
      TARGET_TAG: 'v0.1.7',
      ...overrides,
    },
  })

describe('manual OCI mirror input validation', () => {
  test.each(['nginx', 'library/nginx', 'proompteng/tigresse'])('accepts repository %s under Bash ERE', (repository) => {
    expect(validate({ SOURCE_REPOSITORY: repository }).status).toBe(0)
  })

  test.each(['/nginx', 'nginx/', 'library//nginx', 'Library/nginx'])(
    'rejects repository %s under Bash ERE',
    (repository) => {
      expect(validate({ SOURCE_REPOSITORY: repository }).status).not.toBe(0)
    },
  )

  test('rejects mutable or malformed digests and tags', () => {
    expect(validate({ SOURCE_DIGEST: 'latest' }).status).not.toBe(0)
    expect(validate({ TARGET_TAG: '-bad' }).status).not.toBe(0)
  })
})
