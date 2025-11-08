import { describe, expect, it } from 'bun:test'
import { parseCliFlags, parseCommaList, parseJson, vectorToPgArray } from '../cli'

describe('parseCliFlags', () => {
  it('parses flags with equals and space separators', () => {
    const result = parseCliFlags(['--alpha=one', '--beta', 'two', '--flag'])
    expect(result.alpha).toBe('one')
    expect(result.beta).toBe('two')
    expect(result.flag).toBe(true)
  })

  it('throws if a flag lacks a name', () => {
    expect(() => parseCliFlags(['--', 'value'])).toThrow()
  })
})

describe('parseCommaList', () => {
  it('splits and trims comma-separated values', () => {
    expect(parseCommaList('a, b, ,c')).toEqual(['a', 'b', 'c'])
  })
})

describe('parseJson', () => {
  it('returns parsed object for valid JSON', () => {
    expect(parseJson('{"foo":123}')).toEqual({ foo: 123 })
  })

  it('throws for invalid JSON', () => {
    expect(() => parseJson('{bad}')).toThrow()
  })
})

describe('vectorToPgArray', () => {
  it('formats numbers as pg vector literal', () => {
    expect(vectorToPgArray([1, 2.5, -3])).toBe('[1,2.5,-3]')
  })
})
