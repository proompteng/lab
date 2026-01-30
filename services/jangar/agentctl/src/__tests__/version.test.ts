import { describe, expect, it } from 'bun:test'
import pkg from '../../package.json'
import { getVersion } from '../legacy'

type PackageJson = {
  version?: string
}

const packageJson = pkg as PackageJson

const withEnv = (value: string | undefined, run: () => void) => {
  const previous = process.env.AGENTCTL_VERSION
  if (value === undefined) {
    delete process.env.AGENTCTL_VERSION
  } else {
    process.env.AGENTCTL_VERSION = value
  }
  try {
    run()
  } finally {
    if (previous === undefined) {
      delete process.env.AGENTCTL_VERSION
    } else {
      process.env.AGENTCTL_VERSION = previous
    }
  }
}

describe('getVersion', () => {
  it('prefers AGENTCTL_VERSION when set', () => {
    withEnv('9.9.9', () => {
      expect(getVersion()).toBe('9.9.9')
    })
  })

  it('defaults to package.json version', () => {
    withEnv(undefined, () => {
      expect(getVersion()).toBe(packageJson.version)
    })
  })
})
