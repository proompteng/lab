import { createFileRoute } from '@tanstack/react-router'

import {
  resolveOpenWebUIRenderSigningSecret,
  validateOpenWebUIRenderSignature,
} from '~/server/openwebui-render-signing'
import { getOpenWebUiRenderStore } from '~/server/openwebui-render-store'

export const Route = createFileRoute('/api/openwebui/rich-ui/render/$renderId')({
  server: {
    handlers: {
      GET: async ({ request, params }) => getOpenWebUIRenderHandler(request, params.renderId),
    },
  },
})

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

const buildHtmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-disposition': 'inline',
      'cache-control': 'no-store',
      'access-control-expose-headers': 'Content-Disposition',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; img-src data: https: http:; script-src 'unsafe-inline';",
    },
  })

const buildDocument = (title: string, body: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: ui-monospace, 'SFMono-Regular', Menlo, Monaco, Consolas, monospace;
      }
      body {
        margin: 0;
        padding: 16px;
        background: #0f172a;
        color: #e2e8f0;
      }
      h1 {
        margin: 0 0 12px;
        font-size: 14px;
        line-height: 1.4;
      }
      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        background: #020617;
        border: 1px solid #334155;
        border-radius: 8px;
        padding: 12px;
        font-size: 12px;
        line-height: 1.5;
      }
      .meta {
        margin: 0 0 12px;
        color: #94a3b8;
        font-size: 11px;
      }
    </style>
  </head>
  <body>
    ${body}
    <script>
      const emitHeight = () => {
        const height = Math.max(
          document.documentElement.scrollHeight,
          document.body.scrollHeight,
          document.documentElement.offsetHeight,
          document.body.offsetHeight
        );
        window.parent.postMessage({ type: 'iframe:height', height }, '*');
      };
      new ResizeObserver(emitHeight).observe(document.body);
      window.addEventListener('load', emitHeight);
      setTimeout(emitHeight, 0);
    </script>
  </body>
</html>`

const buildErrorPage = (title: string, message: string) =>
  buildDocument(title, `<h1>${escapeHtml(title)}</h1><pre>${escapeHtml(message)}</pre>`)

const prettyPayload = (payload: Record<string, unknown>) => {
  if (typeof payload.text === 'string') return payload.text
  if (typeof payload.markdown === 'string') return payload.markdown
  return JSON.stringify(payload, null, 2)
}

export const getOpenWebUIRenderHandler = async (request: Request, renderIdRaw: string) => {
  const renderId = renderIdRaw.trim()
  if (!renderId) {
    return buildHtmlResponse(buildErrorPage('Render Unavailable', 'render id is required'), 400)
  }

  let store
  try {
    store = getOpenWebUiRenderStore()
  } catch (error) {
    return buildHtmlResponse(
      buildErrorPage('Render Unavailable', error instanceof Error ? error.message : 'render store unavailable'),
      503,
    )
  }

  const secret = resolveOpenWebUIRenderSigningSecret()
  if (!secret) {
    return buildHtmlResponse(buildErrorPage('Render Unavailable', 'render signing is not configured'), 503)
  }

  const blob = await store.getRenderBlob(renderId)
  if (!blob) {
    return buildHtmlResponse(buildErrorPage('Render Unavailable', 'render payload not found'), 404)
  }

  const url = new URL(request.url)
  const signature = url.searchParams.get('sig')?.trim() ?? ''
  const expiresAtParam = url.searchParams.get('e')?.trim() ?? ''
  const expiresAtSeconds = Number.parseInt(expiresAtParam, 10)
  const expectedExpiresAtSeconds = Math.floor(new Date(blob.expiresAt).getTime() / 1000)

  if (!Number.isFinite(expiresAtSeconds) || expiresAtSeconds !== expectedExpiresAtSeconds) {
    return buildHtmlResponse(buildErrorPage('Render Unavailable', 'render link is invalid'), 404)
  }

  if (Date.now() > new Date(blob.expiresAt).getTime()) {
    return buildHtmlResponse(buildErrorPage('Render Unavailable', 'render link has expired'), 410)
  }

  const valid = validateOpenWebUIRenderSignature({
    renderId: blob.renderId,
    kind: blob.kind,
    expiresAt: blob.expiresAt,
    messageBindingHash: blob.messageBindingHash,
    signature,
    secret,
  })

  if (!valid) {
    return buildHtmlResponse(buildErrorPage('Render Unavailable', 'render link is invalid'), 404)
  }

  const title = blob.preview?.title ?? `${blob.kind} detail`
  const subtitle = blob.preview?.subtitle ?? `${blob.lane} · ${blob.logicalId}`
  const payload = prettyPayload(blob.payload)

  return buildHtmlResponse(
    buildDocument(
      title,
      `<h1>${escapeHtml(title)}</h1><div class="meta">${escapeHtml(subtitle)}</div><pre>${escapeHtml(payload)}</pre>`,
    ),
  )
}
