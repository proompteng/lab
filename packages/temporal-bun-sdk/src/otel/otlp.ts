export type AttributeValue = string | number | boolean | Array<string | number | boolean>

export type OtlpAttributeValue = {
  stringValue?: string
  intValue?: string
  doubleValue?: number
  boolValue?: boolean
  arrayValue?: { values: OtlpAttributeValue[] }
}

export type KeyValue = { key: string; value: OtlpAttributeValue }

export const toUnixNano = (milliseconds: number): string => (BigInt(milliseconds) * 1_000_000n).toString()

export const stableAttributesKey = (attributes: Record<string, AttributeValue> | undefined): string => {
  if (!attributes || Object.keys(attributes).length === 0) {
    return ''
  }
  const entries = Object.keys(attributes)
    .sort()
    .map((key) => [key, attributes[key]])
  return JSON.stringify(entries)
}

const toAttributeValue = (value: AttributeValue): OtlpAttributeValue => {
  if (Array.isArray(value)) {
    return {
      arrayValue: { values: value.map((entry) => toAttributeValue(entry)) },
    }
  }
  switch (typeof value) {
    case 'string':
      return { stringValue: value }
    case 'boolean':
      return { boolValue: value }
    case 'number':
      if (Number.isFinite(value)) {
        if (Number.isInteger(value)) {
          return { intValue: value.toString() }
        }
        return { doubleValue: value }
      }
      return { doubleValue: 0 }
    default:
      return { stringValue: String(value) }
  }
}

export const attributesToKeyValueList = (attributes: Record<string, AttributeValue> | undefined): KeyValue[] => {
  if (!attributes) {
    return []
  }
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value: toAttributeValue(value),
  }))
}
