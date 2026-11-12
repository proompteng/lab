'use client'

import { fromJson } from '@bufbuild/protobuf'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  Button,
  Checkbox,
  Input,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  Skeleton,
} from '@proompteng/design/ui'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { z } from 'zod'
import {
  accessCommandSchema,
  diagnosticActions,
  githubLoginSchema,
  observationScopeSchema,
  workspaceUidSchema,
  type AccessCommand,
} from '@/lib/tengri/access-schemas'
import { PasskeyRequiredError, startSignIn } from '@/lib/platform/auth-client'
import {
  Action,
  ExecuteCommandResponseSchema,
  ListAccessResponseSchema,
  type AccessEntry,
  type ListAccessResponse,
} from '@/lib/tengri/generated/proompteng/authz/v1/authz_pb'
import { SettingsSelect } from '@/components/platform/settings-select'

type ViewState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'roster'; roster: ListAccessResponse }
const actions = ['collaborator', 'grant', 'revoke', 'transfer'] as const
const lines = (value: string) => value.split('\n').filter(Boolean)
const formSchema = z
  .object({
    action: z.enum(actions),
    login: z.string(),
    githubId: z.string(),
    role: z.enum(['developer', 'viewer']),
    enabled: z.boolean(),
    reason: z
      .string()
      .min(3)
      .max(500)
      .regex(/^[^\p{Cc}]+$/u),
    permissions: z.array(z.enum(diagnosticActions)).min(1),
    agentId: z.string(),
    grantId: z.string(),
    proofKeyThumbprint: z.string(),
    expiresAt: z.string(),
    fileRoots: z.string(),
    threadIds: z.string(),
    terminalIds: z.string(),
    browserScreenshot: z.boolean(),
    viewerContent: z.boolean(),
    maxBytes: z.number().int().min(1).max(1_048_576),
    maxItems: z.number().int().min(1).max(200),
  })
  .superRefine((value, context) => {
    if (
      ['collaborator', 'transfer'].includes(value.action) &&
      !value.githubId &&
      !githubLoginSchema.safeParse(value.login).success
    )
      context.addIssue({ code: 'custom', path: ['login'], message: 'Enter a GitHub username' })
    if (
      value.action === 'grant' ||
      (value.action === 'collaborator' && value.enabled && value.role === 'viewer' && value.viewerContent)
    ) {
      const scope = observationScopeSchema.safeParse({
        fileRoots: lines(value.fileRoots),
        threadIds: lines(value.threadIds),
        terminalIds: lines(value.terminalIds),
        browserScreenshot: value.browserScreenshot,
        maxBytes: value.maxBytes,
        maxItems: value.maxItems,
      })
      if (!scope.success)
        for (const issue of scope.error.issues)
          context.addIssue({ code: 'custom', path: issue.path.slice(0, 1), message: issue.message })
    }
    if (value.action === 'grant') {
      if (!workspaceUidSchema.safeParse(value.agentId).success)
        context.addIssue({ code: 'custom', path: ['agentId'], message: 'Enter the diagnostic agent UUID' })
      if (!/^[A-Za-z0-9_-]{43}$/.test(value.proofKeyThumbprint))
        context.addIssue({
          code: 'custom',
          path: ['proofKeyThumbprint'],
          message: 'Enter a 43 character proof key thumbprint',
        })
    }
    if (value.action === 'revoke' && !workspaceUidSchema.safeParse(value.grantId).success)
      context.addIssue({ code: 'custom', path: ['grantId'], message: 'Enter the grant UUID' })
    if (
      ['grant'].includes(value.action) &&
      (!z.iso.datetime().safeParse(value.expiresAt).success || Date.parse(value.expiresAt) <= Date.now())
    )
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Enter a future expiry in UTC, for example 2026-10-10T18:00:00.000Z',
      })
  })
type Form = z.infer<typeof formSchema>
const defaultAccessForm: Form = {
  action: 'collaborator',
  login: '',
  githubId: '',
  role: 'viewer',
  enabled: true,
  reason: '',
  permissions: ['metadata'],
  agentId: '',
  grantId: '',
  proofKeyThumbprint: '',
  expiresAt: '',
  fileRoots: '/workspace/project',
  threadIds: '',
  terminalIds: '',
  browserScreenshot: false,
  viewerContent: false,
  maxBytes: 65536,
  maxItems: 100,
}

export function AccessPanel({ workspaceUid, active = true }: { workspaceUid: string; active?: boolean }) {
  const [data, setData] = useState<ViewState>()
  const loadController = useRef<AbortController | null>(null)
  const current = data
  const roster = current?.kind === 'roster' ? current.roster : undefined
  const entriesBySubject = new Map<string, AccessEntry[]>()
  for (const entry of roster?.entries ?? [])
    entriesBySubject.set(entry.subjectId, [...(entriesBySubject.get(entry.subjectId) ?? []), entry])
  const peopleCount = [...entriesBySubject.values()].filter((entries) => entries.some((entry) => entry.githubId)).length
  const readError = current?.kind === 'error' ? current.message : ''
  const loading = active && (!current || current.kind === 'loading')
  const viewTitle = 'Workspace access'
  const [error, setError] = useState<Error>()
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<AccessCommand>()
  const [credential, setCredential] = useState('')
  const [receipt, setReceipt] = useState('')
  const [editing, setEditing] = useState(false)
  const [personName, setPersonName] = useState('')
  const editorHeading = useRef<HTMLHeadingElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const needsVerification = error instanceof PasskeyRequiredError
  const formId = useId()
  const form = useForm<Form>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      ...defaultAccessForm,
      action: 'collaborator',
      role: 'viewer',
    },
  })
  const action = form.watch('action')
  const role = form.watch('role')
  const enabled = form.watch('enabled')
  const boundedViewer = role === 'viewer' && enabled && form.watch('viewerContent')
  const load = useCallback(
    async (cursor = '') => {
      loadController.current?.abort()
      const controller = new AbortController()
      loadController.current = controller
      setData({ kind: 'loading' })
      const query = new URLSearchParams({ view: 'workspace', workspace: workspaceUid })
      if (cursor) query.set('cursor', cursor)
      setError(undefined)
      try {
        const response = await fetch(`/api/tengri/access?${query}`, { cache: 'no-store', signal: controller.signal })
        const json = z.json().parse(await response.json())
        if (!response.ok) throw new Error(errorMessage(json))
        if (controller.signal.aborted) return
        setData({ kind: 'roster', roster: fromJson(ListAccessResponseSchema, json) })
      } catch (cause) {
        if (!controller.signal.aborted)
          setData({ kind: 'error', message: cause instanceof Error ? cause.message : 'Access is unavailable' })
      }
    },
    [workspaceUid],
  )
  const setValue = form.setValue

  useEffect(() => {
    setValue('action', 'collaborator')
    setValue('role', 'viewer')
    setCredential('')
    setEditing(false)
    setValue('githubId', '')
    setValue('viewerContent', false)
  }, [workspaceUid, setValue])
  useEffect(() => {
    setData(undefined)
    if (!active) return
    void load()
    return () => loadController.current?.abort()
  }, [active, load, receipt])
  useEffect(() => {
    if (editing) editorHeading.current?.focus()
  }, [editing, action, personName])
  const begin = (next: Form['action'], entry?: AccessEntry) => {
    setEditing(true)
    setError(undefined)
    setPersonName(entry ? entry.displayName || `GitHub #${entry.githubId}` : '')
    const scope = entry?.scope
    form.reset({
      ...defaultAccessForm,
      action: next,
      githubId: entry?.githubId || '',
      role: entry?.role === 'developer' ? 'developer' : 'viewer',
      viewerContent: next === 'collaborator' && entry?.role === 'viewer' && Boolean(scope),
      fileRoots: scope ? scope.fileRoots.join('\n') : defaultAccessForm.fileRoots,
      threadIds: scope ? scope.threadIds.join('\n') : '',
      terminalIds: scope ? scope.terminalIds.join('\n') : '',
      browserScreenshot: scope?.browserScreenshot ?? false,
      maxBytes: scope?.maxBytes ?? defaultAccessForm.maxBytes,
      maxItems: scope?.maxItems ?? defaultAccessForm.maxItems,
      grantId: next === 'revoke' ? entry?.grantId || '' : '',
      expiresAt: ['grant'].includes(next) ? new Date(Date.now() + 15 * 60_000).toISOString() : '',
    })
  }

  const execute = async (input: AccessCommand) => {
    setBusy(true)
    setError(undefined)
    setCredential('')
    setPending(input)
    try {
      const response = await fetch('/api/tengri/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      const json = z.json().parse(await response.json())
      if (!response.ok) {
        if (response.status < 500) setPending(undefined)
        if (response.status === 428) throw new PasskeyRequiredError()
        throw new Error(errorMessage(json))
      }
      const result = fromJson(ExecuteCommandResponseSchema, json).receipt
      if (!result) throw new Error('The command receipt is missing. Retry the pending change.')
      setReceipt(`Operation ${result.operationId} · audit ${result.auditReceiptId} · policy version ${result.version}`)
      setCredential(result.agentCredential)
      setPending(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('Change could not be confirmed. Retry the pending change.'))
    } finally {
      setBusy(false)
    }
  }
  const submit = form.handleSubmit(async (value) => {
    if (!roster || pending) return
    const common = {
      operationId: crypto.randomUUID(),
      expectedVersion: roster.version.toString(),
      reason: value.reason,
    }
    const resource = { kind: 'workspace', id: workspaceUid || '' }
    const scope = {
      fileRoots: lines(value.fileRoots),
      threadIds: lines(value.threadIds),
      terminalIds: lines(value.terminalIds),
      browserScreenshot: value.browserScreenshot,
      maxBytes: value.maxBytes,
      maxItems: value.maxItems,
    }
    const recipient = value.githubId
      ? { kind: 'github-id', githubId: value.githubId }
      : { kind: 'github-login', login: value.login }
    let draft: unknown
    switch (value.action) {
      case 'collaborator':
        draft = {
          ...common,
          action: value.action,
          workspaceUid,
          recipient,
          role: value.role,
          enabled: value.enabled,
          ...(value.role === 'viewer' && value.enabled && value.viewerContent ? { scope } : {}),
        }
        break
      case 'grant':
        draft = {
          ...common,
          action: value.action,
          workspaceUid,
          grantId: crypto.randomUUID(),
          agentId: value.agentId,
          resource,
          permissions: value.permissions,
          scope,
          expiresAt: value.expiresAt,
          proofKeyThumbprint: value.proofKeyThumbprint,
        }
        break
      case 'revoke':
        draft = { ...common, action: value.action, workspaceUid, grantId: value.grantId }
        break
      case 'transfer':
        draft = { ...common, action: value.action, workspaceUid, recipient }
        break
    }
    const parsed = accessCommandSchema.safeParse(draft)
    if (!parsed.success) {
      form.setError('root.server', { message: parsed.error.issues.map((issue) => issue.message).join('; ') })
      return
    }
    await execute(parsed.data)
  })
  const field = (
    name: 'login' | 'reason' | 'agentId' | 'grantId' | 'proofKeyThumbprint' | 'expiresAt',
    label: string,
    help?: string,
  ) => (
    <div className="space-y-1">
      <label htmlFor={`${formId}-${name}`} className="block text-xs text-zinc-200">
        {label}
      </label>
      <Input
        id={`${formId}-${name}`}
        {...form.register(name, {
          onChange: name === 'login' ? () => form.setValue('viewerContent', false) : undefined,
        })}
        aria-invalid={Boolean(form.formState.errors[name])}
        autoComplete="off"
      />
      {help ? <p className="text-xs text-zinc-400">{help}</p> : null}
      {form.formState.errors[name] ? (
        <p role="alert" className="text-xs text-red-300">
          {form.formState.errors[name]?.message}
        </p>
      ) : null}
    </div>
  )
  const checkbox = (name: 'enabled' | 'viewerContent' | 'browserScreenshot', text: string) => (
    <div className="flex items-center gap-2 text-xs">
      <Controller
        name={name}
        control={form.control}
        render={({ field }) => (
          <Checkbox
            id={`${formId}-${name}`}
            checked={field.value}
            onCheckedChange={(checked) => {
              field.onChange(checked)
              if (name === 'enabled') form.setValue('viewerContent', false)
            }}
            onBlur={field.onBlur}
            disabled={busy || Boolean(pending)}
          />
        )}
      />
      <label htmlFor={`${formId}-${name}`}>{text}</label>
    </div>
  )
  const textareaClass =
    'rounded-md border border-zinc-700 bg-zinc-900 px-2 py-2 text-base sm:text-xs text-zinc-100 focus-visible:outline-2 focus-visible:outline-zinc-400'
  return (
    <section aria-label="Access administration" className="@container/access min-w-0 space-y-4 text-zinc-200">
      <div className="flex items-center justify-between gap-2">
        <a
          href="https://admin.proompteng.ai/"
          target="_blank"
          rel="noreferrer"
          className="text-xs text-zinc-400 underline underline-offset-4"
        >
          Workspace administration
        </a>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void load()}>
          Refresh
        </Button>
      </div>
      <div className="space-y-4" aria-busy={loading}>
        <div className="space-y-1">
          <h2 className="text-sm font-medium">{viewTitle}</h2>
          {loading ? (
            <div role="status" aria-label={`Loading ${viewTitle}`} className="space-y-3">
              <span className="sr-only">Loading {viewTitle}…</span>
              <div aria-hidden="true" className="space-y-3">
                <Skeleton className="h-8 w-full bg-zinc-700/40" />
                <Skeleton className="h-5 w-3/4 bg-zinc-700/40" />
                <Skeleton className="h-5 w-1/2 bg-zinc-700/40" />
              </div>
            </div>
          ) : null}
          <p className="text-xs leading-5 text-zinc-400">Choose who can view or develop in this workspace.</p>
        </div>
        {error || readError ? (
          <p role="alert" className="rounded-md border border-red-900 bg-red-950/40 p-3 text-xs text-red-200">
            {error?.message || readError}
          </p>
        ) : null}
        {pending ? (
          <div className="rounded-md border border-amber-800 p-3 text-xs">
            <p>
              The result of operation {pending.operationId} is unconfirmed. Retry it before starting another change.
            </p>
            <Button type="button" size="sm" disabled={busy} onClick={() => void execute(pending)}>
              Retry pending change
            </Button>
          </div>
        ) : null}
        {credential ? (
          <div className="space-y-2 rounded-md border border-amber-800 p-3">
            <p className="text-xs text-amber-200">
              Save this credential now. Ofz returns it once. The agent also needs its matching private proof key.
            </p>
            <Input aria-label="New diagnostic credential" readOnly value={credential} autoComplete="off" />
            <Button type="button" size="sm" variant="ghost" onClick={() => setCredential('')}>
              Dismiss credential
            </Button>
          </div>
        ) : null}
        {receipt ? (
          <div role="status" className="space-y-1 text-xs text-zinc-400">
            <p className="text-zinc-200">Access updated.</p>
            <details>
              <summary className="cursor-pointer">View receipt</summary>
              <p className="mt-1 break-all">{receipt}</p>
            </details>
          </div>
        ) : null}
        {roster ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-zinc-400">
                {peopleCount} {peopleCount === 1 ? 'person' : 'people'}
                {roster.workspaceState ? ` · Workspace ${roster.workspaceState}` : ''}
              </p>
              <Button
                ref={addButton}
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || Boolean(pending)}
                onClick={() => begin('collaborator')}
              >
                {'Add collaborator'}
              </Button>
            </div>
            <ItemGroup className="gap-0 overflow-hidden rounded-lg border border-zinc-700/70 bg-zinc-900/30">
              {[...entriesBySubject].map(([subject, entries]) => {
                const first = entries[0]
                if (!first) return null
                const name = first.displayName || (first.githubId ? `GitHub #${first.githubId}` : 'Diagnostic agent')
                return (
                  <Item
                    role="listitem"
                    key={subject}
                    size="sm"
                    className="items-start rounded-none border-0 border-b border-zinc-700/60 px-3 py-3 last:border-b-0"
                  >
                    <ItemContent>
                      <ItemTitle>
                        {first.githubId ? (
                          <a
                            href={`https://github.com/account/redirect?user_id=${encodeURIComponent(first.githubId)}`}
                            target="_blank"
                            rel="noreferrer"
                            className="underline-offset-4 hover:underline"
                          >
                            {name}
                          </a>
                        ) : (
                          name
                        )}
                      </ItemTitle>
                      <ItemDescription>
                        {entries.map((entry) => (
                          <span key={entry.role} className="mr-2 inline-block capitalize">
                            {entry.role}
                          </span>
                        ))}
                      </ItemDescription>
                      {entries.map((entry) =>
                        entry.role === 'viewer' ? (
                          <p key={entry.role} className="text-xs text-zinc-400">
                            {entry.scope ? 'Bounded content access' : 'Metadata only'}
                          </p>
                        ) : null,
                      )}
                      {entries.some((entry) => entry.scope || entry.grantId || entry.expiresAtUnixMs > BigInt(0)) ? (
                        <details className="text-xs text-zinc-400">
                          <summary className="cursor-pointer">Access details</summary>
                          <div className="mt-2 space-y-2">
                            {entries.map((entry) => (
                              <div key={entry.role + entry.grantId}>
                                {!entry.githubId ? (
                                  <p className="break-all font-mono">Agent {entry.subjectId}</p>
                                ) : null}
                                {entry.grantId ? <p className="break-all">Grant {entry.grantId}</p> : null}
                                {entry.scope ? (
                                  <>
                                    <dl className="space-y-1">
                                      {[
                                        { label: 'File roots', targets: entry.scope.fileRoots },
                                        { label: 'Codex thread IDs', targets: entry.scope.threadIds },
                                        { label: 'Terminal IDs', targets: entry.scope.terminalIds },
                                      ].map(({ label, targets }) => (
                                        <div key={label}>
                                          <dt>{label}</dt>
                                          <dd className="break-all whitespace-pre-wrap font-mono">
                                            {targets.length
                                              ? targets.map((target) => JSON.stringify(target)).join('\n')
                                              : 'None'}
                                          </dd>
                                        </div>
                                      ))}
                                    </dl>
                                    <p>
                                      {entry.role === 'viewer' || entry.actions.includes(Action.BROWSER_OBSERVE) ? (
                                        <>Browser status{entry.scope.browserScreenshot ? ' and screenshots' : ''} · </>
                                      ) : null}
                                      up to {entry.scope.maxBytes} bytes / {entry.scope.maxItems} items
                                    </p>
                                  </>
                                ) : null}
                                {entry.expiresAtUnixMs > BigInt(0) ? (
                                  <p>Expires {new Date(Number(entry.expiresAtUnixMs)).toLocaleString()}</p>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        </details>
                      ) : null}
                    </ItemContent>
                    <ItemActions className="flex-wrap">
                      {entries
                        .filter((entry) => ['viewer', 'developer', 'diagnostic'].includes(entry.role))
                        .map((entry) => (
                          <Button
                            key={entry.role + entry.grantId}
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={busy || Boolean(pending)}
                            aria-label={`Manage ${name} ${entry.role}${entry.githubId ? '' : ` ${entry.subjectId}`}`}
                            onClick={() => begin(entry.grantId ? 'revoke' : 'collaborator', entry)}
                          >
                            {entry.grantId ? 'Revoke grant' : entries.length > 1 ? `Edit ${entry.role}` : 'Manage'}
                          </Button>
                        ))}
                    </ItemActions>
                  </Item>
                )
              })}
              {!roster.entries.length ? (
                <p role="listitem" className="p-4 text-xs text-zinc-400">
                  No people on this page.
                </p>
              ) : null}
            </ItemGroup>
            {roster.cursor ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy || Boolean(pending)}
                onClick={() => void load(roster.cursor)}
              >
                Next access page
              </Button>
            ) : null}
            {!editing ? (
              <details className="rounded-lg border border-zinc-700/70">
                <summary className="cursor-pointer p-3 text-xs font-medium">Advanced access & recovery</summary>
                <div className="space-y-2 border-t border-zinc-700/60 p-3">
                  <p className="text-xs leading-5 text-zinc-400">
                    Time-limited diagnostic access and ownership transfer.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {(
                      [
                        { action: 'grant', label: 'Create diagnostic grant' },
                        { action: 'revoke', label: 'Revoke diagnostic grant' },
                        { action: 'transfer', label: 'Transfer ownership' },
                      ] as const
                    ).map((item) => (
                      <Button
                        key={item.action}
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy || Boolean(pending)}
                        onClick={() => begin(item.action)}
                      >
                        {item.label}
                      </Button>
                    ))}
                  </div>
                </div>
              </details>
            ) : null}
            <details className="text-[11px] text-zinc-400">
              <summary className="cursor-pointer">Policy details</summary>
              <p className="pt-1">Policy version {roster.version.toString()}</p>
            </details>
            {editing ? (
              <form
                noValidate
                onSubmit={submit}
                className="space-y-3 rounded-md border border-zinc-700 bg-zinc-900/60 p-3"
              >
                <fieldset disabled={busy || Boolean(pending)} className="space-y-3">
                  <legend className="sr-only">Change access</legend>
                  <div className="flex items-center justify-between gap-2">
                    <h3 ref={editorHeading} tabIndex={-1} className="text-sm font-medium outline-none">
                      {action === 'collaborator'
                        ? 'Collaborator access'
                        : action === 'transfer'
                          ? 'Transfer ownership'
                          : action === 'grant'
                            ? 'Create diagnostic grant'
                            : 'Revoke diagnostic grant'}
                    </h3>
                    <Button
                      size="sm"
                      variant="ghost"
                      type="button"
                      onClick={() => {
                        setEditing(false)
                        setError(undefined)
                        addButton.current?.focus()
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                  {['grant', 'revoke', 'transfer'].includes(action) ? (
                    <label className="flex items-center gap-2 text-xs">
                      Action
                      <Controller
                        name="action"
                        control={form.control}
                        render={({ field }) => (
                          <SettingsSelect
                            {...field}
                            aria-label="Change"
                            disabled={busy || Boolean(pending)}
                            onValueChange={(value) => {
                              const next = z.enum(actions).parse(value)
                              field.onChange(next)
                              form.setValue('viewerContent', false)
                              form.setValue('role', 'viewer')
                              if (['grant'].includes(next))
                                form.setValue('expiresAt', new Date(Date.now() + 15 * 60_000).toISOString())
                            }}
                            options={['collaborator', 'grant', 'revoke', 'transfer'].map((value) => ({
                              value,
                              label: value.charAt(0).toUpperCase() + value.slice(1),
                            }))}
                          />
                        )}
                      />
                    </label>
                  ) : null}
                  {form.watch('githubId') ? (
                    <div className="rounded-md bg-zinc-800/70 px-3 py-2 text-xs">
                      <p className="font-medium">{personName}</p>
                      <p className="text-zinc-400">GitHub #{form.watch('githubId')}</p>
                    </div>
                  ) : ['collaborator', 'transfer'].includes(action) ? (
                    field(
                      'login',
                      'GitHub username',
                      'The server verifies its numeric GitHub ID before changing policy.',
                    )
                  ) : null}
                  {['collaborator'].includes(action) ? (
                    <label className="flex items-center gap-2 text-xs">
                      Role
                      <Controller
                        name="role"
                        control={form.control}
                        render={({ field }) => (
                          <SettingsSelect
                            {...field}
                            aria-label="Role"
                            disabled={busy || Boolean(pending)}
                            onValueChange={(value) => {
                              field.onChange(value)
                              form.setValue('viewerContent', false)
                            }}
                            options={['developer', 'viewer'].map((value) => ({
                              value,
                              label: value.charAt(0).toUpperCase() + value.slice(1),
                            }))}
                          />
                        )}
                      />
                    </label>
                  ) : null}
                  {['collaborator'].includes(action) ? checkbox('enabled', 'Enable this access') : null}
                  {action === 'collaborator' && form.watch('role') === 'viewer' && form.watch('enabled')
                    ? checkbox('viewerContent', 'Approve bounded Viewer content access')
                    : null}
                  {action === 'collaborator' ? (
                    <p className="text-xs leading-5 text-zinc-400">
                      Developer access includes a root shell. Removing it quarantines this workspace until credentials
                      and the guest are recovered. Viewers see metadata unless you explicitly allow bounded content
                      access.
                    </p>
                  ) : null}
                  {action === 'grant' ? (
                    <>
                      {field('agentId', 'Diagnostic agent UUID')}
                      {field('proofKeyThumbprint', 'Proof key thumbprint', 'The private key stays with the agent.')}
                      <fieldset className="flex flex-wrap gap-3">
                        <legend className="mb-1 text-xs">Observation permissions</legend>
                        {diagnosticActions.map((permission) => (
                          <label key={permission} className="flex items-center gap-1 text-xs">
                            <Controller
                              name="permissions"
                              control={form.control}
                              render={({ field }) => (
                                <Checkbox
                                  checked={field.value.includes(permission)}
                                  onCheckedChange={(checked) =>
                                    field.onChange(
                                      checked
                                        ? [...field.value, permission]
                                        : field.value.filter((item) => item !== permission),
                                    )
                                  }
                                  disabled={busy || Boolean(pending)}
                                />
                              )}
                            />
                            {permission}
                          </label>
                        ))}
                      </fieldset>
                    </>
                  ) : null}
                  {action === 'grant' || (action === 'collaborator' && boundedViewer) ? (
                    <fieldset className="space-y-3">
                      <legend className="mb-1 text-xs">Approved observation scope</legend>
                      <p className="text-xs text-zinc-400">
                        Only the listed content targets are readable. Browser status is included; screenshots require
                        separate approval. Observation does not start services or send input. Selected content can
                        contain private information.
                      </p>
                      {(
                        [
                          ['fileRoots', 'File roots under /workspace'],
                          ['threadIds', 'Codex thread IDs'],
                          ['terminalIds', 'Terminal IDs'],
                        ] as const
                      ).map(([name, label]) => (
                        <div key={name} className="space-y-1 text-xs">
                          <label htmlFor={`${formId}-${name}`} className="block">
                            {label}
                          </label>
                          <textarea
                            id={`${formId}-${name}`}
                            {...form.register(name)}
                            rows={2}
                            aria-invalid={Boolean(form.formState.errors[name])}
                            aria-describedby={form.formState.errors[name] ? `${formId}-${name}-error` : undefined}
                            className={`${textareaClass} block w-full`}
                            placeholder="One approved target per line"
                          />
                          {form.formState.errors[name] ? (
                            <p id={`${formId}-${name}-error`} role="alert" className="text-red-300">
                              {form.formState.errors[name]?.message}
                            </p>
                          ) : null}
                        </div>
                      ))}
                      {checkbox('browserScreenshot', 'Allow browser screenshots')}
                      <div className="flex gap-2">
                        {(
                          [
                            ['maxBytes', 'Maximum bytes'],
                            ['maxItems', 'Maximum items'],
                          ] as const
                        ).map(([name, label]) => (
                          <div key={name} className="space-y-1 text-xs">
                            <label htmlFor={`${formId}-${name}`} className="block">
                              {label}
                            </label>
                            <Input
                              id={`${formId}-${name}`}
                              type="number"
                              {...form.register(name, { valueAsNumber: true })}
                              aria-invalid={Boolean(form.formState.errors[name])}
                              aria-describedby={form.formState.errors[name] ? `${formId}-${name}-error` : undefined}
                            />
                            {form.formState.errors[name] ? (
                              <p id={`${formId}-${name}-error`} role="alert" className="text-red-300">
                                {form.formState.errors[name]?.message}
                              </p>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </fieldset>
                  ) : null}
                  {action === 'revoke' ? field('grantId', 'Grant UUID') : null}
                  {['grant'].includes(action)
                    ? field('expiresAt', 'Expiry in UTC', 'Maximum one hour. Default fifteen minutes.')
                    : null}

                  {action === 'transfer' ? (
                    <p className="text-xs text-amber-200">
                      Transfer revokes existing diagnostic grants and quarantines the retained guest. Recovery must
                      complete before the new owner can open content.
                    </p>
                  ) : null}
                  {field(
                    'reason',
                    'Reason',
                    'Keep credentials, personal data, prompts and file contents out of this audit reason.',
                  )}
                  {form.formState.errors.root?.server ? (
                    <p role="alert" className="text-xs text-red-300">
                      {form.formState.errors.root.server.message}
                    </p>
                  ) : null}
                  <Button
                    type={needsVerification ? 'button' : 'submit'}
                    size="sm"
                    disabled={busy}
                    onClick={
                      needsVerification
                        ? () =>
                            void startSignIn('step-up').catch(() =>
                              setError(new PasskeyRequiredError('Verification could not start. Try again.')),
                            )
                        : undefined
                    }
                  >
                    {busy ? 'Applying…' : needsVerification ? 'Verify identity' : 'Save changes'}
                  </Button>
                </fieldset>
              </form>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  )
}

function errorMessage(json: unknown) {
  const parsed = z.object({ error: z.string().max(500) }).safeParse(json)
  return parsed.success ? parsed.data.error : 'The access request failed'
}
