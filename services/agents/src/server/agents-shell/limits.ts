export const asPositiveInteger = (value: unknown, key: string, fallback: number, max: number, min = 1) => {
  if (value == null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new Error(`${key} must be a number between ${min} and ${max}`)
  }
  return Math.min(Math.floor(value), max)
}
