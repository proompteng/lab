'use client'

import { Button, Field, FieldLabel, Input } from '@proompteng/design/ui'
import { useId } from 'react'
import { usePortalQuery } from './collection-view'
import { SettingsSelect } from './settings-select'
import type { GetPlatformWorkspaceResponse } from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'

export function ActivityFilters({ detail }: { detail: GetPlatformWorkspaceResponse }) {
  const { query, change } = usePortalQuery()
  const id = useId()
  return (
    <form
      className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-3"
      onSubmit={(event) => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        const action = data.get('action')
        change({ action: typeof action === 'string' ? action : '', cursor: '' })
      }}
    >
      <Field>
        <FieldLabel htmlFor={id}>Exact action</FieldLabel>
        <Input
          key={query.get('action') || ''}
          id={id}
          name="action"
          defaultValue={query.get('action') || ''}
          placeholder="e.g. ofz.relationships.write"
          maxLength={128}
          className="text-base sm:text-sm"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={id + '-outcome'}>Outcome</FieldLabel>
        <SettingsSelect
          id={id + '-outcome'}
          name="outcome"
          value={query.get('outcome') || 'all'}
          onValueChange={(value) => change({ outcome: value === 'all' ? '' : value, cursor: '' })}
          options={[
            { value: 'all', label: 'All outcomes' },
            { value: 'allowed', label: 'Allowed' },
            { value: 'denied', label: 'Denied' },
          ]}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={id + '-actor'}>Actor</FieldLabel>
        <SettingsSelect
          id={id + '-actor'}
          name="actorId"
          value={query.get('actorId') || 'all'}
          onValueChange={(value) => change({ actorId: value === 'all' ? '' : value, cursor: '' })}
          options={[
            { value: 'all', label: 'All actors' },
            ...detail.members.map((member) => ({
              value: member.humanId,
              label: member.displayName || `GitHub ${member.githubId}`,
            })),
            ...detail.clients
              .filter((entry) => entry.client)
              .map((entry) => ({ value: entry.client!.id, label: entry.client!.displayName })),
          ]}
        />
      </Field>

      <div className="flex gap-2 sm:col-span-2 lg:col-span-3">
        <Button size="sm" type="submit" variant="outline">
          Apply action filter
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => change({ action: '', outcome: '', actorId: '', cursor: '' })}
        >
          Clear filters
        </Button>
      </div>
    </form>
  )
}
