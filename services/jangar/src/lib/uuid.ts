const formatUuid = (bytes: Uint8Array) => {
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const randomBytes = (size: number) => {
  const bytes = new Uint8Array(size)
  const globalCrypto = globalThis.crypto
  if (globalCrypto?.getRandomValues) {
    globalCrypto.getRandomValues(bytes)
    return bytes
  }

  for (let i = 0; i < size; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256)
  }
  return bytes
}

export const randomUuid = () => {
  const globalCrypto = globalThis.crypto
  if (typeof globalCrypto?.randomUUID === 'function') {
    return globalCrypto.randomUUID()
  }

  const bytes = randomBytes(16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return formatUuid(bytes)
}
