'use client'

import { fromJson } from '@bufbuild/protobuf'
import { zodResolver } from '@hookform/resolvers/zod'
import { Button, Input } from '@proompteng/design/ui'
import { useCallback, useEffect, useId, useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import {
  accessCommandSchema,
  diagnosticActions,
  githubLoginSchema,
  workspaceUidSchema,
  type AccessCommand,
} from '@/lib/tengri/access-schemas'
import { startTengriSignIn } from '@/lib/tengri/auth-client'
import {
  Action,
  ExecuteCommandResponseSchema,
  ListAccessResponseSchema,
  ReadAuditResponseSchema,
  type ListAccessResponse,
  type ReadAuditResponse,
} from '@/lib/tengri/generated/proompteng/authz/v1/authz_pb'

type View = 'workspace' | 'platform' | 'audit'
const actions = ['membership', 'collaborator', 'quota', 'target', 'grant', 'revoke', 'transfer', 'emergency'] as const
const formSchema = z
  .object({
    action: z.enum(actions),
    login: z.string(),
    role: z.enum(['member', 'administrator', 'auditor', 'operator', 'developer', 'viewer']),
    enabled: z.boolean(),
    reason: z
      .string()
      .min(3)
      .max(500)
      .regex(/^[^\p{Cc}]+$/u),
    total: z.number().int().min(0).max(6),
    active: z.number().int().min(0).max(6),
    retainedGiB: z.number().int().min(0).max(192),
    resourceKind: z.enum(['workspace', 'namespace', 'connector']),
    resourceId: z.string(),
    permission: z.enum(['kube-status', 'kube-logs', 'kube-events', 'connector']),
    permissions: z.array(z.enum(diagnosticActions)).min(1),
    agentId: z.string(),
    grantId: z.string(),
    proofKeyThumbprint: z.string(),
    expiresAt: z.string(),
    fileRoots: z.string(),
    threadIds: z.string(),
    terminalIds: z.string(),
    browserScreenshot: z.boolean(),
    maxBytes: z.number().int().min(1).max(1_048_576),
    maxItems: z.number().int().min(1).max(200),
    incidentId: z.string(),
    approvalId: z.string(),
  })
  .superRefine((value, context) => {
    if (
      ['membership', 'collaborator', 'quota', 'target', 'transfer', 'emergency'].includes(value.action) &&
      !githubLoginSchema.safeParse(value.login).success
    )
      context.addIssue({ code: 'custom', path: ['login'], message: 'Enter a GitHub username' })
    if (value.action === 'quota' && value.active > value.total)
      context.addIssue({ code: 'custom', path: ['active'], message: 'Active quota cannot exceed total quota' })
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
      ['grant', 'emergency'].includes(value.action) &&
      (!z.iso.datetime().safeParse(value.expiresAt).success || Date.parse(value.expiresAt) <= Date.now())
    )
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Enter a future expiry in UTC, for example 2026-10-10T18:00:00.000Z',
      })
  })
type Form = z.infer<typeof formSchema>
const lines = (value: string) =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

export function AccessPanel({ workspaceUid, active = true }: { workspaceUid?: string; active?: boolean }) {
  const [view, setView] = useState<View>(workspaceUid ? 'workspace' : 'platform')
  const [roster, setRoster] = useState<ListAccessResponse>()
  const [audit, setAudit] = useState<ReadAuditResponse>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<AccessCommand>()
  const [credential, setCredential] = useState('')
  const [receipt, setReceipt] = useState('')
  const formId = useId()
  const form = useForm<Form>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      action: workspaceUid ? 'collaborator' : 'membership',
      login: '',
      role: workspaceUid ? 'viewer' : 'member',
      enabled: true,
      reason: '',
      total: 2,
      active: 1,
      retainedGiB: 64,
      resourceKind: 'workspace',
      resourceId: workspaceUid || '',
      permission: 'kube-status',
      permissions: ['metadata'],
      agentId: '',
      grantId: '',
      proofKeyThumbprint: '',
      expiresAt: '',
      fileRoots: '/workspace/project',
      threadIds: '',
      terminalIds: '',
      browserScreenshot: false,
      maxBytes: 65536,
      maxItems: 100,
      incidentId: '',
      approvalId: '',
    },
  })
  const action = form.watch('action')
  const resourceKind = form.watch('resourceKind')
  const load = useCallback(
    async (signal?: AbortSignal, cursor = '') => {
      const query = new URLSearchParams({ view })
      if (cursor) query.set('cursor', cursor)
      if (view === 'workspace' && workspaceUid) query.set('workspace', workspaceUid)
      setError('')
      try {
        const response = await fetch(`/api/tengri/access?${query}`, { cache: 'no-store', signal })
        const json = z.json().parse(await response.json())
        if (!response.ok) throw new Error(errorMessage(json))
        if (signal?.aborted) return
        if (view === 'audit') setAudit(fromJson(ReadAuditResponseSchema, json))
        else setRoster(fromJson(ListAccessResponseSchema, json))
      } catch (cause) {
        if (!signal?.aborted) setError(cause instanceof Error ? cause.message : 'Access is unavailable')
      }
    },
    [view, workspaceUid],
  )
  const setValue = form.setValue
  useEffect(() => {
    setValue('action', view === 'workspace' ? 'collaborator' : 'membership')
    setValue('role', view === 'workspace' ? 'viewer' : 'member')
    setCredential('')
  }, [view, setValue])
  useEffect(() => {
    setRoster(undefined)
    setAudit(undefined)
    if (!active) return
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [active, load])
  const execute = async (input: AccessCommand) => {
    setBusy(true)
    setError('')
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
        if (response.status === 428) throw new Error('Verify with your passkey, then repeat this change.')
        throw new Error(errorMessage(json))
      }
      const result = fromJson(ExecuteCommandResponseSchema, json).receipt
      if (!result) throw new Error('The command receipt is missing. Retry the pending change.')
      setReceipt(`Operation ${result.operationId} · audit ${result.auditReceiptId} · policy version ${result.version}`)
      setCredential(result.agentCredential)
      setPending(undefined)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Change could not be confirmed. Retry the pending change.')
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
    const resource = {
      kind: value.resourceKind,
      id: value.resourceKind === 'workspace' ? workspaceUid || '' : value.resourceId,
    }
    let draft: unknown
    switch (value.action) {
      case 'membership':
        draft = { ...common, action: value.action, login: value.login, role: value.role, enabled: value.enabled }
        break
      case 'collaborator':
        draft = {
          ...common,
          action: value.action,
          workspaceUid,
          login: value.login,
          role: value.role,
          enabled: value.enabled,
        }
        break
      case 'quota':
        draft = {
          ...common,
          action: value.action,
          login: value.login,
          total: value.total,
          active: value.active,
          retainedGiB: value.retainedGiB,
        }
        break
      case 'target':
        draft = {
          ...common,
          action: value.action,
          login: value.login,
          resource,
          permission: value.permission,
          enabled: value.enabled,
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
          scope: {
            fileRoots: lines(value.fileRoots),
            threadIds: lines(value.threadIds),
            terminalIds: lines(value.terminalIds),
            browserScreenshot: value.browserScreenshot,
            maxBytes: value.maxBytes,
            maxItems: value.maxItems,
          },
          expiresAt: value.expiresAt,
          proofKeyThumbprint: value.proofKeyThumbprint,
        }
        break
      case 'revoke':
        draft = { ...common, action: value.action, workspaceUid, grantId: value.grantId }
        break
      case 'transfer':
        draft = { ...common, action: value.action, workspaceUid, login: value.login }
        break
      case 'emergency':
        draft = {
          ...common,
          action: value.action,
          workspaceUid,
          login: value.login,
          incidentId: value.incidentId,
          approvalId: value.approvalId,
          expiresAt: value.expiresAt,
        }
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
    name:
      | 'login'
      | 'reason'
      | 'agentId'
      | 'grantId'
      | 'proofKeyThumbprint'
      | 'expiresAt'
      | 'resourceId'
      | 'incidentId'
      | 'approvalId',
    label: string,
    help?: string,
  ) => (
    <div className="space-y-1">
      <label htmlFor={`${formId}-${name}`} className="block text-xs text-zinc-200">
        {label}
      </label>
      <Input
        id={`${formId}-${name}`}
        {...form.register(name)}
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
  const selectClass =
    'rounded-md border border-zinc-700 bg-zinc-900 px-2 py-2 text-xs text-zinc-100 focus-visible:outline-2 focus-visible:outline-zinc-400'
  return (
    <section className="space-y-4 text-zinc-200" aria-label="Access administration">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Access view">
        {(['workspace', 'platform', 'audit'] as const)
          .filter((item) => item !== 'workspace' || workspaceUid)
          .map((item) => (
            <Button
              type="button"
              key={item}
              size="sm"
              variant={view === item ? 'secondary' : 'ghost'}
              onClick={() => setView(item)}
              aria-pressed={view === item}
            >
              {item === 'workspace' ? 'Workspace' : item === 'platform' ? 'Platform' : 'Audit'}
            </Button>
          ))}
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void load()}>
          Refresh
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || Boolean(pending)}
          onClick={() => void startTengriSignIn(true).catch(() => setError('Passkey verification could not start'))}
        >
          Verify passkey
        </Button>
      </div>
      <p className="text-xs leading-5 text-zinc-400">
        Owners manage workspace collaborators and bounded diagnostic grants. Platform administrators manage membership,
        quotas and broker permissions. Developer access includes a root shell. Removing it quarantines the retained
        workspace until credentials and the guest are recovered.
      </p>
      {error ? (
        <p role="alert" className="rounded-md border border-red-900 bg-red-950/40 p-3 text-xs text-red-200">
          {error}
        </p>
      ) : null}
      {pending ? (
        <div className="rounded-md border border-amber-800 p-3 text-xs">
          <p>The result of operation {pending.operationId} is unconfirmed. Retry it before starting another change.</p>
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
        <p role="status" className="break-all text-xs text-emerald-300">
          {receipt}
        </p>
      ) : null}
      {roster ? (
        <>
          <div className="overflow-x-auto rounded-md border border-zinc-700">
            <table className="w-full text-left text-xs">
              <caption className="p-2 text-left text-zinc-400">
                Policy version {roster.version.toString()}
                {roster.workspaceState ? ` · ${roster.workspaceState}` : ''}
              </caption>
              <thead className="bg-zinc-900">
                <tr>
                  <th className="p-2">Identity</th>
                  <th className="p-2">Role</th>
                  <th className="p-2">Scope / expiry</th>
                </tr>
              </thead>
              <tbody>
                {roster.entries.map((entry) => (
                  <tr key={`${entry.subjectId}/${entry.role}/${entry.grantId}`} className="border-t border-zinc-800">
                    <td className="max-w-56 break-all p-2">
                      {entry.githubId ? (
                        <a
                          className="underline"
                          href={`https://github.com/account/redirect?user_id=${encodeURIComponent(entry.githubId)}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          GitHub #{entry.githubId}
                        </a>
                      ) : (
                        entry.subjectId
                      )}
                      {entry.grantId ? <p className="text-zinc-400">Grant {entry.grantId}</p> : null}
                    </td>
                    <td className="p-2">{entry.role}</td>
                    <td className="p-2">
                      {entry.actions.map((permission) => Action[permission]).join(', ')}
                      {entry.scope ? (
                        <p className="whitespace-pre-wrap text-zinc-400">
                          {[...entry.scope.fileRoots, ...entry.scope.threadIds, ...entry.scope.terminalIds].join('\n')}
                        </p>
                      ) : null}
                      {entry.expiresAtUnixMs > BigInt(0) ? new Date(Number(entry.expiresAtUnixMs)).toISOString() : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {roster.quotas.map((quota) => (
            <p key={quota.humanId} className="text-xs text-zinc-400">
              {quota.humanId.slice(0, 12)} · workspaces {quota.usedWorkspaces}/{quota.totalWorkspaces} · active{' '}
              {quota.usedActive}/{quota.activeWorkspaces} · retained{' '}
              {(Number(quota.usedBytes) / 1_073_741_824).toFixed(0)}/
              {(Number(quota.retainedBytes) / 1_073_741_824).toFixed(0)} GiB
            </p>
          ))}
          {roster.cursor ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => void load(undefined, roster.cursor)}>
              Next access page
            </Button>
          ) : null}
          <form noValidate onSubmit={submit} className="space-y-3 rounded-md border border-zinc-700 bg-zinc-900/60 p-3">
            <fieldset disabled={busy || Boolean(pending)} className="space-y-3">
              <legend className="mb-2 text-sm font-medium">Change access</legend>
              <label className="flex items-center gap-2 text-xs">
                Change
                <select
                  aria-label="Change"
                  className={selectClass}
                  {...form.register('action')}
                  onChange={(event) => {
                    const next = z.enum(actions).parse(event.target.value)
                    form.setValue('action', next)
                    form.setValue('role', next === 'collaborator' ? 'viewer' : 'member')
                    form.setValue('resourceKind', next === 'target' ? 'namespace' : 'workspace')
                    if (['grant', 'emergency'].includes(next))
                      form.setValue('expiresAt', new Date(Date.now() + 15 * 60_000).toISOString())
                  }}
                >
                  {(view === 'workspace'
                    ? ['collaborator', 'grant', 'revoke', 'transfer', 'emergency']
                    : ['membership', 'quota', 'target']
                  ).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              {['membership', 'collaborator', 'quota', 'target', 'transfer', 'emergency'].includes(action)
                ? field('login', 'GitHub username', 'The server verifies its numeric GitHub ID before changing policy.')
                : null}
              {['membership', 'collaborator'].includes(action) ? (
                <label className="flex items-center gap-2 text-xs">
                  Role
                  <select aria-label="Role" {...form.register('role')} className={selectClass}>
                    {(action === 'membership'
                      ? ['member', 'administrator', 'auditor', 'operator']
                      : ['developer', 'viewer']
                    ).map((role) => (
                      <option key={role}>{role}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              {['membership', 'collaborator', 'target'].includes(action) ? (
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" {...form.register('enabled')} /> Enable this access
                </label>
              ) : null}
              {action === 'quota' ? (
                <div className="grid grid-cols-3 gap-2">
                  {(['total', 'active', 'retainedGiB'] as const).map((name) => (
                    <label key={name} className="space-y-1 text-xs">
                      {name}
                      <Input
                        type="number"
                        {...form.register(name, { valueAsNumber: true })}
                        aria-invalid={Boolean(form.formState.errors[name])}
                      />
                      {form.formState.errors[name] ? (
                        <span role="alert" className="text-red-300">
                          {form.formState.errors[name]?.message}
                        </span>
                      ) : null}
                    </label>
                  ))}
                </div>
              ) : null}
              {['target', 'grant'].includes(action) ? (
                <>
                  <label className="flex items-center gap-2 text-xs">
                    Resource
                    <select aria-label="Resource" className={selectClass} {...form.register('resourceKind')}>
                      {(action === 'target' ? ['namespace', 'connector'] : ['workspace', 'namespace', 'connector']).map(
                        (kind) => (
                          <option key={kind}>{kind}</option>
                        ),
                      )}
                    </select>
                  </label>
                  {resourceKind !== 'workspace'
                    ? field(
                        'resourceId',
                        'Reviewed target identity',
                        'Use the namespace or connector identity from the reviewed broker catalog.',
                      )
                    : null}
                </>
              ) : null}
              {action === 'target' ? (
                <label className="flex items-center gap-2 text-xs">
                  Permission
                  <select aria-label="Permission" className={selectClass} {...form.register('permission')}>
                    {['kube-status', 'kube-logs', 'kube-events', 'connector'].map((permission) => (
                      <option key={permission}>{permission}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              {action === 'grant' ? (
                <>
                  {field('agentId', 'Diagnostic agent UUID')}
                  {field('proofKeyThumbprint', 'Proof key thumbprint', 'The private key stays with the agent.')}
                  <fieldset className="flex flex-wrap gap-3">
                    <legend className="mb-1 text-xs">Observation permissions</legend>
                    {diagnosticActions.map((permission) => (
                      <label key={permission} className="flex items-center gap-1 text-xs">
                        <input type="checkbox" value={permission} {...form.register('permissions')} />
                        {permission}
                      </label>
                    ))}
                  </fieldset>
                  {(['fileRoots', 'threadIds', 'terminalIds'] as const).map((name) => (
                    <label key={name} className="block space-y-1 text-xs">
                      {name}
                      <textarea
                        {...form.register(name)}
                        rows={2}
                        className={`${selectClass} block w-full`}
                        placeholder="One approved target per line"
                      />
                    </label>
                  ))}
                  <label className="flex items-center gap-2 text-xs">
                    <input type="checkbox" {...form.register('browserScreenshot')} /> Allow browser screenshots
                  </label>
                  <div className="flex gap-2">
                    {(['maxBytes', 'maxItems'] as const).map((name) => (
                      <label key={name} className="text-xs">
                        {name}
                        <Input type="number" {...form.register(name, { valueAsNumber: true })} />
                      </label>
                    ))}
                  </div>
                </>
              ) : null}
              {action === 'revoke' ? field('grantId', 'Grant UUID') : null}
              {['grant', 'emergency'].includes(action)
                ? field(
                    'expiresAt',
                    'Expiry in UTC',
                    action === 'grant'
                      ? 'Maximum one hour. Default fifteen minutes.'
                      : 'Maximum thirty minutes. Both custodians must approve the same exact expiry.',
                  )
                : null}
              {action === 'emergency' ? (
                <>
                  {field('incidentId', 'Incident reference')}
                  {field(
                    'approvalId',
                    'First custodian operation UUID',
                    'Leave empty for the first approval. A different custodian completes the second approval.',
                  )}
                </>
              ) : null}
              {action === 'transfer' ? (
                <p className="text-xs text-amber-200">
                  Transfer revokes existing diagnostic grants and quarantines the retained guest. Recovery must complete
                  before the new owner can open content.
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
              <Button type="submit" size="sm">
                {busy ? 'Applying…' : 'Apply change'}
              </Button>
            </fieldset>
          </form>
        </>
      ) : null}
      {audit ? (
        <div className="max-h-96 space-y-2 overflow-auto text-xs">
          {audit.receipts.map((entry) => (
            <div key={entry.id} className="rounded border border-zinc-800 p-2">
              <p>
                #{entry.sequence.toString()} · {new Date(Number(entry.createdAtUnixMs)).toISOString()} ·{' '}
                {entry.allowed ? 'Allow' : 'Deny'} · {Action[entry.action]}
              </p>
              <p className="break-all text-zinc-400">
                {entry.id} · {entry.reason}
              </p>
            </div>
          ))}
          {audit.cursor ? (
            <Button type="button" size="sm" onClick={() => void load(undefined, audit.cursor)}>
              Next audit page
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function errorMessage(json: unknown) {
  const parsed = z.object({ error: z.string().max(500) }).safeParse(json)
  return parsed.success ? parsed.data.error : 'The access request failed'
}
