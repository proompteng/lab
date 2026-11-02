'use client'

import { fromJson } from '@bufbuild/protobuf'
import { Button } from '@proompteng/design/ui'
import { useEffect, useRef, useState } from 'react'
import { accessRequestMutationSchema, type AccessRequestMutation } from '@/lib/platform/access-requests'
import { startSignIn } from '@/lib/platform/auth-client'
import { PlatformClientError, readPlatformResponse } from '@/lib/platform/client'
import {
  CreatePlatformAccessRequestResponseSchema,
  ReviewPlatformAccessRequestResponseSchema,
  CancelPlatformAccessRequestResponseSchema,
} from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'

export function useAccessRequestMutation(storageKey: string, onChanged: () => void) {
  const inFlight = useRef(false)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const [ready, setReady] = useState(false)
  const [pending, setPending] = useState<AccessRequestMutation>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error>()
  useEffect(() => {
    setReady(false)
    setPending(undefined)
    setError(undefined)
    try {
      const value = sessionStorage.getItem(storageKey)
      if (value) setPending(accessRequestMutationSchema.parse(JSON.parse(value)))
      setReady(true)
    } catch {
      setError(new Error('The saved request could not be read. Keep this tab open and retry.'))
    }
  }, [storageKey])
  const save = async (intent: AccessRequestMutation) => {
    if (inFlight.current || !active.current) return
    inFlight.current = true
    setBusy(true)
    setError(undefined)
    try {
      const saved = sessionStorage.getItem(storageKey)
      if (
        saved &&
        JSON.stringify(accessRequestMutationSchema.parse(JSON.parse(saved))) !==
          JSON.stringify(accessRequestMutationSchema.parse(intent))
      )
        throw new Error('Reconcile the saved change before submitting a different operation.')
      const body = saved || JSON.stringify(accessRequestMutationSchema.parse(intent))
      sessionStorage.setItem(storageKey, body)
      setPending(intent)
      const json = await fetch('/api/platform/access-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }).then(readPlatformResponse)
      const result =
        intent.kind === 'create'
          ? fromJson(CreatePlatformAccessRequestResponseSchema, json)
          : intent.kind === 'review'
            ? fromJson(ReviewPlatformAccessRequestResponseSchema, json)
            : fromJson(CancelPlatformAccessRequestResponseSchema, json)
      if (!result.decision?.allowed || !result.decision.auditReceiptId)
        throw new Error('The request is unconfirmed. Retry the saved request.')
      sessionStorage.removeItem(storageKey)
      setPending(undefined)
      if (active.current) onChanged()
    } catch (cause) {
      if (
        cause instanceof PlatformClientError &&
        cause.status < 500 &&
        ![401, 403, 408, 428, 429].includes(cause.status)
      ) {
        sessionStorage.removeItem(storageKey)
        setPending(undefined)
        if (active.current) onChanged()
      }
      setError(cause instanceof Error ? cause : new Error('The request could not be confirmed.'))
    } finally {
      inFlight.current = false
      if (active.current) setBusy(false)
    }
  }
  return { ready, pending, busy, error, save }
}

export function AccessRequestMutationStatus({ mutation }: { mutation: ReturnType<typeof useAccessRequestMutation> }) {
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<Error>()
  const status = mutation.error instanceof PlatformClientError ? mutation.error.status : 0
  const authenticate = async () => {
    setOpening(true)
    setError(undefined)
    try {
      await startSignIn(status === 428 ? 'step-up' : undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('Sign-in could not start.'))
      setOpening(false)
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
            {status === 428
              ? 'Verify your identity to approve this access.'
              : status === 401
                ? 'Sign in to finish your saved request.'
                : 'Your request is saved. Confirm it before making another change.'}
          </p>
          {'reason' in mutation.pending ? <p className="text-xs text-zinc-400">{mutation.pending.reason}</p> : null}
          <Button
            size="sm"
            disabled={mutation.busy || opening}
            onClick={() => {
              if ([401, 428].includes(status)) void authenticate()
              else if (mutation.pending) void mutation.save(mutation.pending)
            }}
          >
            {opening
              ? 'Opening…'
              : mutation.busy
                ? 'Saving…'
                : status === 428
                  ? 'Verify & continue'
                  : status === 401
                    ? 'Sign in'
                    : 'Retry saved request'}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-red-300">
          {error.message}
        </p>
      ) : null}
    </div>
  )
}
