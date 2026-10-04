import { describe, expect, it } from 'vitest'

import {
  canonicalizeForJsonHash,
  isNonBlankString,
  renderTemplate,
  resolvePath,
  sha256Hex,
  stableJsonStringifyForHash,
} from '~/server/agents-controller/template-hash'

describe('agents controller template-hash module', () => {
  it('detects non-blank strings', () => {
    expect(isNonBlankString('value')).toBe(true)
    expect(isNonBlankString('   ')).toBe(false)
    expect(isNonBlankString(1)).toBe(false)
  })

  it('resolves nested dot paths and guards invalid traversals', () => {
    const context = {
      event: {
        repository: {
          owner: 'acme',
        },
      },
      list: [1, 2],
    }

    expect(resolvePath(context, 'event.repository.owner')).toBe('acme')
    expect(resolvePath(context, 'event.missing')).toBeNull()
    expect(resolvePath(context, 'list.value')).toBeNull()
  })

  it('renders templates with string and JSON values', () => {
    const rendered = renderTemplate('repo={{ event.repository }} data={{ payload }} miss={{ missing }}', {
      event: { repository: 'acme/repo' },
      payload: { a: 1 },
    })

    expect(rendered).toBe('repo=acme/repo data={"a":1} miss=')
  })

  it('canonicalizes json hash inputs by sorting keys and dropping undefined', () => {
    const canonical = canonicalizeForJsonHash({
      z: 1,
      a: { y: 2, x: undefined, b: [{ d: 3, c: 2 }] },
    })

    expect(canonical).toEqual({
      a: { b: [{ c: 2, d: 3 }], y: 2 },
      z: 1,
    })
  })

  it('produces deterministic stable json strings', () => {
    const a = stableJsonStringifyForHash({ b: 1, a: 2 })
    const b = stableJsonStringifyForHash({ a: 2, b: 1 })
    expect(a).toBe(b)
    expect(a).toBe('{"a":2,"b":1}')
  })

  it('hashes strings as sha256 hex', () => {
    expect(sha256Hex('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })
})
