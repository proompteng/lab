import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { Controller, useForm } from 'react-hook-form'
import { z } from 'zod'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { Button, buttonVariants } from '~/components/ui/button'
import { Card, CardContent, CardFooter } from '~/components/ui/card'
import { Field, FieldError, FieldGroup, FieldLabel } from '~/components/ui/field'
import { Input } from '~/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { Spinner } from '~/components/ui/spinner'
import { Textarea } from '~/components/ui/textarea'
import { GatewayFrame, GatewayPageHeader } from '~/components/gateway-shell'
import { createLiveAgentRun, fetchLiveAgents } from '~/lib/sag-client'
import { loadInitialSnapshot } from '~/lib/load-snapshot'
import { cn } from '~/lib/utils'

export const Route = createFileRoute('/agent-runs_/new')({
  component: NewAgentRunRoute,
  loader: loadInitialSnapshot,
})

const agentRunFormSchema = z.object({
  task: z.string().trim().min(1, 'Task is required.'),
  agent: z.string().trim().min(1, 'Agent is required.'),
  repository: z.string().trim().min(1, 'Repository is required.'),
})

type AgentRunFormValues = z.infer<typeof agentRunFormSchema>

function NewAgentRunRoute() {
  const initialSnapshot = Route.useLoaderData()
  const navigate = Route.useNavigate()
  const form = useForm<AgentRunFormValues>({
    resolver: zodResolver(agentRunFormSchema),
    mode: 'onChange',
    defaultValues: {
      task: '',
      agent: 'codex-agent',
      repository: 'proompteng/lab',
    },
  })
  const {
    formState: { errors, isValid },
    register,
    control,
  } = form
  const agentsQuery = useQuery({
    queryKey: ['live-agents'],
    queryFn: fetchLiveAgents,
    staleTime: 30_000,
  })
  const agents = agentsQuery.data?.agents ?? []

  const createMutation = useMutation({
    mutationFn: createLiveAgentRun,
    onSuccess: async (result) => {
      await navigate({
        to: '/agent-runs/$name',
        params: {
          name: result.run.name,
        },
      })
    },
  })

  const submitRun = form.handleSubmit((values) => {
    createMutation.mutate({ ...values, namespace: 'agents' })
  })

  return (
    <GatewayFrame active="/agent-runs" snapshot={initialSnapshot}>
      <GatewayPageHeader title="New Agent Run" active="/agent-runs" breadcrumbs={[{ label: 'New Agent Run' }]} />
      <main className="min-h-0 flex-1 p-4">
        <form onSubmit={submitRun} className="max-w-2xl">
          <Card>
            <CardContent>
              <FieldGroup>
                <Field data-invalid={Boolean(errors.task)}>
                  <FieldLabel htmlFor="agent-run-task">Task</FieldLabel>
                  <Textarea
                    id="agent-run-task"
                    rows={8}
                    placeholder="Describe the work."
                    aria-invalid={Boolean(errors.task)}
                    {...register('task')}
                  />
                  <FieldError errors={[errors.task]} />
                </Field>
                <Field data-invalid={Boolean(errors.agent)}>
                  <FieldLabel htmlFor="agent-run-agent">Agent</FieldLabel>
                  <Controller
                    control={control}
                    name="agent"
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={(value) => field.onChange(value ?? '')}>
                        <SelectTrigger
                          id="agent-run-agent"
                          className="w-full"
                          aria-invalid={Boolean(errors.agent)}
                          disabled={agentsQuery.isLoading || agents.length === 0}
                        >
                          <SelectValue placeholder={agentsQuery.isLoading ? 'Loading agents' : 'Select agent'} />
                        </SelectTrigger>
                        <SelectContent>
                          {agents.map((agent) => (
                            <SelectItem key={`${agent.namespace}/${agent.name}`} value={agent.name}>
                              {agent.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                  <FieldError errors={[errors.agent]} />
                </Field>
                <Field data-invalid={Boolean(errors.repository)}>
                  <FieldLabel htmlFor="agent-run-repository">Repository</FieldLabel>
                  <Input
                    id="agent-run-repository"
                    aria-invalid={Boolean(errors.repository)}
                    {...register('repository')}
                  />
                  <FieldError errors={[errors.repository]} />
                </Field>
              </FieldGroup>
              {createMutation.error ? (
                <Alert variant="destructive" className="mt-4">
                  <AlertTitle>Create failed</AlertTitle>
                  <AlertDescription>{createMutation.error.message}</AlertDescription>
                </Alert>
              ) : null}
            </CardContent>
            <CardFooter className="justify-end gap-2">
              <Link
                to="/agent-runs"
                search={{ phase: undefined }}
                className={cn(buttonVariants({ variant: 'outline' }))}
              >
                Cancel
              </Link>
              <Button type="submit" disabled={!isValid || createMutation.isPending}>
                {createMutation.isPending ? <Spinner data-icon="inline-start" /> : null}
                Create
              </Button>
            </CardFooter>
          </Card>
        </form>
      </main>
    </GatewayFrame>
  )
}
