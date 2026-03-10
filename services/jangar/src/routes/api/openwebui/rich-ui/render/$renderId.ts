import { createFileRoute } from '@tanstack/react-router'

import { recordOpenWebUIDetailRouteRequest } from '~/server/metrics'
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
      .stack {
        display: grid;
        gap: 16px;
      }
      .panel {
        background: #020617;
        border: 1px solid #334155;
        border-radius: 10px;
        padding: 12px;
      }
      .label {
        margin: 0 0 8px;
        color: #94a3b8;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      ul {
        margin: 0;
        padding-left: 20px;
      }
      a {
        color: #7dd3fc;
      }
      img {
        display: block;
        max-width: 100%;
        height: auto;
        border-radius: 10px;
        border: 1px solid #334155;
        background: #020617;
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

const prettyJson = (payload: unknown) => JSON.stringify(payload, null, 2)

const renderMetaLine = (label: string, value: string | null | undefined) =>
  value ? `<div class="meta">${escapeHtml(label)}: ${escapeHtml(value)}</div>` : ''

const renderTextPanel = (label: string, value: string, language = 'text') =>
  `<section class="panel"><div class="label">${escapeHtml(label)}</div><pre data-language="${escapeHtml(language)}">${escapeHtml(value)}</pre></section>`

const renderJsonPanel = (label: string, value: unknown) => renderTextPanel(label, prettyJson(value), 'json')

const renderPayload = (kind: string, payload: Record<string, unknown>, subtitle: string) => {
  const format = typeof payload.format === 'string' ? payload.format : kind

  if (format === 'command') {
    const command = typeof payload.command === 'string' ? payload.command : 'command'
    const text = typeof payload.text === 'string' ? payload.text : ''
    const status = typeof payload.status === 'string' ? payload.status : null
    const exitCode =
      typeof payload.exitCode === 'number' && Number.isFinite(payload.exitCode) ? String(payload.exitCode) : null
    return `<div class="stack">
      ${renderMetaLine('Summary', subtitle)}
      ${renderMetaLine('Status', status)}
      ${renderMetaLine('Exit code', exitCode)}
      ${renderTextPanel('Command', command, 'bash')}
      ${renderTextPanel('Transcript', text)}
    </div>`
  }

  if (format === 'diff') {
    const text = typeof payload.text === 'string' ? payload.text : ''
    const paths = Array.isArray(payload.paths)
      ? payload.paths.filter((value): value is string => typeof value === 'string')
      : []
    const pathList =
      paths.length > 0
        ? `<section class="panel"><div class="label">Changed Paths</div><ul>${paths.map((path) => `<li><code>${escapeHtml(path)}</code></li>`).join('')}</ul></section>`
        : ''
    return `<div class="stack">
      ${renderMetaLine('Summary', subtitle)}
      ${pathList}
      ${renderTextPanel('Unified Diff', text, 'diff')}
    </div>`
  }

  if (format === 'image') {
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : null
    const status = typeof payload.status === 'string' ? payload.status : null
    const imageUrl = typeof payload.imageUrl === 'string' ? payload.imageUrl : null
    return `<div class="stack">
      ${renderMetaLine('Summary', subtitle)}
      ${renderMetaLine('Status', status)}
      ${prompt ? `<section class="panel"><div class="label">Prompt</div><pre>${escapeHtml(prompt)}</pre></section>` : ''}
      ${
        imageUrl
          ? `<section class="panel"><div class="label">Preview</div><p><a href="${escapeHtml(imageUrl)}" target="_blank" rel="noopener noreferrer">Open original asset</a></p><img src="${escapeHtml(imageUrl)}" alt="Generated image preview" /></section>`
          : renderTextPanel('Detail', 'Image asset unavailable')
      }
    </div>`
  }

  if (format === 'markdown') {
    const markdown = typeof payload.markdown === 'string' ? payload.markdown : ''
    return `<div class="stack">
      ${renderMetaLine('Summary', subtitle)}
      ${renderTextPanel('Markdown', markdown, 'markdown')}
    </div>`
  }

  if (format === 'text') {
    const text = typeof payload.text === 'string' ? payload.text : prettyJson(payload)
    return `<div class="stack">
      ${renderMetaLine('Summary', subtitle)}
      ${renderTextPanel('Detail', text)}
    </div>`
  }

  return `<div class="stack">
    ${renderMetaLine('Summary', subtitle)}
    ${renderJsonPanel('JSON', payload)}
  </div>`
}

export const getOpenWebUIRenderHandler = async (request: Request, renderIdRaw: string) => {
  const renderId = renderIdRaw.trim()
  if (!renderId) {
    recordOpenWebUIDetailRouteRequest('unknown', 'bad_request')
    return buildHtmlResponse(buildErrorPage('Render Unavailable', 'render id is required'), 400)
  }

  let store
  try {
    store = getOpenWebUiRenderStore()
  } catch (error) {
    recordOpenWebUIDetailRouteRequest('unknown', 'store_unavailable')
    return buildHtmlResponse(
      buildErrorPage('Render Unavailable', error instanceof Error ? error.message : 'render store unavailable'),
      503,
    )
  }

  const secret = resolveOpenWebUIRenderSigningSecret()
  if (!secret) {
    recordOpenWebUIDetailRouteRequest('unknown', 'signing_unavailable')
    return buildHtmlResponse(buildErrorPage('Render Unavailable', 'render signing is not configured'), 503)
  }

  const blob = await store.getRenderBlob(renderId)
  if (!blob) {
    recordOpenWebUIDetailRouteRequest('unknown', 'missing_blob')
    return buildHtmlResponse(buildErrorPage('Render Unavailable', 'render payload not found'), 404)
  }

  const url = new URL(request.url)
  const signature = url.searchParams.get('sig')?.trim() ?? ''
  const expiresAtParam = url.searchParams.get('e')?.trim() ?? ''
  const expiresAtSeconds = Number.parseInt(expiresAtParam, 10)
  const expectedExpiresAtSeconds = Math.floor(new Date(blob.expiresAt).getTime() / 1000)

  if (!Number.isFinite(expiresAtSeconds) || expiresAtSeconds !== expectedExpiresAtSeconds) {
    recordOpenWebUIDetailRouteRequest(blob.kind, 'invalid_signature')
    return buildHtmlResponse(buildErrorPage('Render Unavailable', 'render link is invalid'), 404)
  }

  if (Date.now() > new Date(blob.expiresAt).getTime()) {
    recordOpenWebUIDetailRouteRequest(blob.kind, 'expired')
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
    recordOpenWebUIDetailRouteRequest(blob.kind, 'invalid_signature')
    return buildHtmlResponse(buildErrorPage('Render Unavailable', 'render link is invalid'), 404)
  }

  const title = blob.preview?.title ?? `${blob.kind} detail`
  const subtitle = blob.preview?.subtitle ?? `${blob.lane} · ${blob.logicalId}`
  recordOpenWebUIDetailRouteRequest(blob.kind, 'ok')

  return buildHtmlResponse(
    buildDocument(title, `<h1>${escapeHtml(title)}</h1>${renderPayload(blob.kind, blob.payload, subtitle)}`),
  )
}
