'use client'

import { fromJson } from '@bufbuild/protobuf'
import { Button } from '@proompteng/design/ui'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { startSignIn } from '@/lib/platform/auth-client'
import { PlatformClientError, readPlatformResponse } from '@/lib/platform/client'
import { policyWriteSchema, type PolicyWrite } from '@/lib/platform/policies'
import { WritePolicyRelationshipsResponseSchema } from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'

export function usePolicyMutation(workspaceId: string, humanId: string, scope: string, onChanged: () => void) {
  const storageKey = `platform-policy:${humanId}:${workspaceId}:${scope}`
  const [ready, setReady] = useState(false)
  const [pending, setPending] = useState<PolicyWrite>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error>()
  const [receipt, setReceipt] = useState('')
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(storageKey)
      if (saved) {
        const parsed = policyWriteSchema.parse(JSON.parse(saved))
        if (parsed.workspaceId !== workspaceId) throw new Error('Saved change belongs to another workspace.')
        setPending(parsed)
      }
      setReady(true)
    } catch {
      setError(new Error('The saved access change could not be read. Keep this tab open and retry.'))
    }
  }, [storageKey, workspaceId])
  const save = async (request: PolicyWrite) => {
    setBusy(true)
    setError(undefined)
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(request))
      setPending(request)
      const response = await fetch('/api/platform/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      })
      const result = fromJson(WritePolicyRelationshipsResponseSchema, await readPlatformResponse(response))
      if (!result.decision?.allowed || !result.decision.auditReceiptId)
        throw new Error('The change is unconfirmed. Retry the saved change.')
      sessionStorage.removeItem(storageKey)
      setPending(undefined)
      setReceipt(result.decision.auditReceiptId)
      toast.success('Access updated')
      onChanged()
    } catch (cause) {
      if (cause instanceof PlatformClientError && cause.status < 500 && cause.status !== 428) {
        sessionStorage.removeItem(storageKey)
        setPending(undefined)
      }
      setError(cause instanceof Error ? cause : new Error('The change could not be confirmed.'))
    } finally {
      setBusy(false)
    }
  }
  const cancel = () => {
    if (busy || !(error instanceof PlatformClientError) || error.status !== 428) return
    sessionStorage.removeItem(storageKey)
    setPending(undefined)
    setError(undefined)
  }
  return { save, cancel, ready, pending, busy, error, receipt }
}

export function PolicyMutationStatus({ mutation }: { mutation: ReturnType<typeof usePolicyMutation> }) {
  const verify = mutation.error instanceof PlatformClientError && mutation.error.status === 428
  const [verifying, setVerifying] = useState(false)
  const [verificationError, setVerificationError] = useState<Error>()
  const verifyIdentity = async () => {
    setVerifying(true)
    setVerificationError(undefined)
    try {
      await startSignIn('step-up')
    } catch (cause) {
      setVerificationError(cause instanceof Error ? cause : new Error('Verification could not start.'))
      setVerifying(false)
    }
  }
  return (
    <div className="space-y-2 text-sm">
      {mutation.error ? (
        <p role="alert" className="text-red-300">
          {mutation.error.message}
        </p>
      ) : null}
      {mutation.pending ? (
        <div className="space-y-2 rounded-lg border border-zinc-800 p-3">
          <p className="text-zinc-400">
            {verify
              ? 'Verify your identity to apply this access change.'
              : 'A saved access change is waiting for confirmation.'}
          </p>
          <p className="text-xs text-zinc-400">{mutation.pending.reason}</p>
          <Button
            size="sm"
            disabled={mutation.busy || verifying}
            onClick={() => {
              if (verify) void verifyIdentity()
              else if (mutation.pending) void mutation.save(mutation.pending)
            }}
          >
            {verifying
              ? 'Opening verification…'
              : mutation.busy
                ? 'Saving…'
                : verify
                  ? 'Verify & continue'
                  : 'Retry saved change'}
          </Button>
          {verify ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={mutation.busy || verifying}
              onClick={mutation.cancel}
            >
              Cancel change
            </Button>
          ) : null}
          {verificationError ? (
            <p role="alert" className="text-red-300">
              {verificationError.message}
            </p>
          ) : null}
        </div>
      ) : null}
      {mutation.receipt ? (
        <div role="status" className="text-zinc-400">
          <p className="text-zinc-200">Access updated.</p>
          <details className="mt-1 text-xs">
            <summary className="cursor-pointer">View receipt</summary>
            <p className="mt-1 break-all">{mutation.receipt}</p>
          </details>
        </div>
      ) : null}
    </div>
  )
}
