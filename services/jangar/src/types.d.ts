declare module '*.css?url' {
  const href: string
  export default href
}

declare module 'nitro/runtime' {
  export const defineNitroPlugin: (plugin: (nitroApp?: unknown) => void) => unknown
}
