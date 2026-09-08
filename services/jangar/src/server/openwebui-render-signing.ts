import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

import { resolveChatConfig } from './chat-config'
import { OPENWEBUI_RENDER_BLOB_TTL_SECONDS } from './openwebui-render-store'

type RenderSignaturePayload = {
  renderId: string
  kind: string
  expiresAt: string
  messageBindingHash: string
}

export const OPENWEBUI_RENDER_URL_TTL_SECONDS = OPENWEBUI_RENDER_BLOB_TTL_SECONDS

const toBase64Url = (buffer: Buffer) =>
  buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll(/=+$/g, '')

const fromBase64Url = (value: string) => {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4))
  return Buffer.from(`${normalized}${padding}`, 'base64')
}

const safeTimingEqual = (left: string, right: string) => {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) return false
  return timingSafeEqual(leftBuffer, rightBuffer)
}

const normalizeBaseUrl = (value: string) => value.trim().replace(/\/+$/g, '')

const serializePayload = (payload: RenderSignaturePayload) =>
  `${payload.renderId}:${payload.kind}:${payload.expiresAt}:${payload.messageBindingHash}`

export const createMessageBindingHash = (sessionId: string) => createHash('sha256').update(sessionId).digest('hex')

export const buildOpenWebUIRenderSignature = (payload: RenderSignaturePayload, secret: string) =>
  toBase64Url(createHmac('sha256', secret).update(serializePayload(payload)).digest())

export const createSignedOpenWebUIRenderHref = (args: {
  baseUrl: string
  renderId: string
  kind: string
  expiresAt: string
  messageBindingHash: string
  secret: string
}) => {
  const baseUrl = normalizeBaseUrl(args.baseUrl)
  const signature = buildOpenWebUIRenderSignature(
    {
      renderId: args.renderId,
      kind: args.kind,
      expiresAt: args.expiresAt,
      messageBindingHash: args.messageBindingHash,
    },
    args.secret,
  )
  const expiresAtSeconds = Math.floor(new Date(args.expiresAt).getTime() / 1000)
  const url = new URL(`${baseUrl}/api/openwebui/rich-ui/render/${encodeURIComponent(args.renderId)}`)
  url.searchParams.set('e', String(expiresAtSeconds))
  url.searchParams.set('sig', signature)
  return url.toString()
}

export const validateOpenWebUIRenderSignature = (args: {
  renderId: string
  kind: string
  expiresAt: string
  messageBindingHash: string
  signature: string
  secret: string
}) => {
  if (!args.signature || !args.secret) return false
  let parsedSignature: Buffer
  let expectedSignature: Buffer

  try {
    parsedSignature = fromBase64Url(args.signature)
    expectedSignature = fromBase64Url(
      buildOpenWebUIRenderSignature(
        {
          renderId: args.renderId,
          kind: args.kind,
          expiresAt: args.expiresAt,
          messageBindingHash: args.messageBindingHash,
        },
        args.secret,
      ),
    )
  } catch {
    return false
  }

  return safeTimingEqual(parsedSignature.toString('hex'), expectedSignature.toString('hex'))
}

export const resolveOpenWebUIRenderSigningSecret = () => {
  return resolveChatConfig().openWebUIRenderSigningSecret
}
