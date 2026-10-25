if (typeof window !== 'undefined') {
  process.env.NODE_ENV = 'test'
  process.env.VITEST = 'true'
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
}
