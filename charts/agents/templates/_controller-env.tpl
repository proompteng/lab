{{- define "agents.runnerRetentionEnv" -}}
{{- $controller := .root.Values.controller -}}
{{- $jobTtl := $controller.jobTtlSecondsAfterFinished -}}
{{- /* Preserve the combined deployment's precedence for explicit legacy values. */ -}}
{{- if hasKey $controller "jobTtlSeconds" -}}
{{- $jobTtl = $controller.jobTtlSeconds -}}
{{- end -}}
{{- if and (not (hasKey .envVars "AGENTS_AGENT_RUNNER_JOB_TTL_SECONDS")) (ne $jobTtl nil) }}
- name: AGENTS_AGENT_RUNNER_JOB_TTL_SECONDS
  value: {{ $jobTtl | quote }}
{{- end }}
{{- if and (not (hasKey .envVars "AGENTS_AGENT_RUNNER_LOG_RETENTION_SECONDS")) (hasKey $controller "logRetentionSeconds") }}
- name: AGENTS_AGENT_RUNNER_LOG_RETENTION_SECONDS
  value: {{ $controller.logRetentionSeconds | quote }}
{{- end }}
{{- if not (hasKey .envVars "AGENTS_AGENTRUN_ARTIFACTS_MAX") }}
- name: AGENTS_AGENTRUN_ARTIFACTS_MAX
  value: {{ dig "agentRunArtifacts" "max" 50 $controller | quote }}
{{- end }}
{{- if not (hasKey .envVars "AGENTS_AGENTRUN_ARTIFACTS_STRICT") }}
- name: AGENTS_AGENTRUN_ARTIFACTS_STRICT
  value: {{ dig "agentRunArtifacts" "strict" false $controller | quote }}
{{- end }}
{{- end }}

{{- define "agents.controllerEnv" -}}
{{- $envVars := .envVars -}}
{{- with .root -}}
{{- if .Values.controller.enabled -}}
- name: AGENTS_CONTROLLER_NAMESPACES
  value: {{ include "agents.controllerNamespaces" . | quote }}
- name: AGENTS_CONTROLLER_CONCURRENCY_NAMESPACE
  value: {{ .Values.controller.concurrency.perNamespace | default 10 | quote }}
- name: AGENTS_CONTROLLER_CONCURRENCY_AGENT
  value: {{ .Values.controller.concurrency.perAgent | default 5 | quote }}
- name: AGENTS_CONTROLLER_CONCURRENCY_CLUSTER
  value: {{ .Values.controller.concurrency.cluster | default 100 | quote }}
{{- if not (hasKey $envVars "AGENTS_CONTROLLER_REPO_CONCURRENCY_ENABLED") }}
- name: AGENTS_CONTROLLER_REPO_CONCURRENCY_ENABLED
  value: {{ .Values.controller.repoConcurrency.enabled | default false | quote }}
{{- end }}
{{- if not (hasKey $envVars "AGENTS_CONTROLLER_REPO_CONCURRENCY_DEFAULT") }}
- name: AGENTS_CONTROLLER_REPO_CONCURRENCY_DEFAULT
  value: {{ .Values.controller.repoConcurrency.default | default 0 | quote }}
{{- end }}
{{- if not (hasKey $envVars "AGENTS_CONTROLLER_REPO_CONCURRENCY_OVERRIDES") }}
- name: AGENTS_CONTROLLER_REPO_CONCURRENCY_OVERRIDES
  value: {{ .Values.controller.repoConcurrency.overrides | default dict | toJson | quote }}
{{- end }}
- name: AGENTS_CONTROLLER_QUEUE_NAMESPACE
  value: {{ .Values.controller.queue.perNamespace | default 200 | quote }}
- name: AGENTS_CONTROLLER_QUEUE_REPO
  value: {{ .Values.controller.queue.perRepo | default 50 | quote }}
- name: AGENTS_CONTROLLER_QUEUE_CLUSTER
  value: {{ .Values.controller.queue.cluster | default 1000 | quote }}
- name: AGENTS_CONTROLLER_RATE_WINDOW_SECONDS
  value: {{ .Values.controller.rate.windowSeconds | default 60 | quote }}
- name: AGENTS_CONTROLLER_RATE_NAMESPACE
  value: {{ .Values.controller.rate.perNamespace | default 120 | quote }}
- name: AGENTS_CONTROLLER_RATE_REPO
  value: {{ .Values.controller.rate.perRepo | default 30 | quote }}
- name: AGENTS_CONTROLLER_RATE_CLUSTER
  value: {{ .Values.controller.rate.cluster | default 600 | quote }}
- name: AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS
  value: {{ .Values.controller.agentRunRetentionSeconds | default 2592000 | quote }}
- name: AGENTS_CONTROLLER_AGENTRUN_RETENTION_MAX_DELETES_PER_NAMESPACE
  value: {{ .Values.controller.agentRunRetentionMaxDeletesPerNamespace | default 100 | quote }}
- name: AGENTS_CONTROLLER_AGENTRUN_RETENTION_ZERO_TTL_MAX_SECONDS
  value: {{ .Values.controller.agentRunRetentionZeroTtlMaxSeconds | default 0 | quote }}
{{- $runtimeDebrisCleanup := .Values.controller.runtimeDebrisCleanup | default dict }}
{{- if not (hasKey $envVars "AGENTS_CONTROLLER_RUNTIME_DEBRIS_CLEANUP_MODE") }}
- name: AGENTS_CONTROLLER_RUNTIME_DEBRIS_CLEANUP_MODE
  value: {{ $runtimeDebrisCleanup.mode | default "disabled" | quote }}
{{- end }}
{{- if not (hasKey $envVars "AGENTS_CONTROLLER_ORPHAN_POD_RETENTION_SECONDS") }}
- name: AGENTS_CONTROLLER_ORPHAN_POD_RETENTION_SECONDS
  value: {{ dig "orphanPodRetentionSeconds" 86400 $runtimeDebrisCleanup | quote }}
{{- end }}
{{- if not (hasKey $envVars "AGENTS_CONTROLLER_RUNTIME_DEBRIS_MAX_DELETES_PER_NAMESPACE") }}
- name: AGENTS_CONTROLLER_RUNTIME_DEBRIS_MAX_DELETES_PER_NAMESPACE
  value: {{ dig "maxDeletesPerNamespace" 25 $runtimeDebrisCleanup | quote }}
{{- end }}
{{- if and .Values.controller.admissionPolicy.labels.required (gt (len .Values.controller.admissionPolicy.labels.required) 0) }}
- name: AGENTS_CONTROLLER_LABELS_REQUIRED
  value: {{ .Values.controller.admissionPolicy.labels.required | toJson | quote }}
{{- end }}
{{- if and .Values.controller.admissionPolicy.labels.allowed (gt (len .Values.controller.admissionPolicy.labels.allowed) 0) }}
- name: AGENTS_CONTROLLER_LABELS_ALLOWED
  value: {{ .Values.controller.admissionPolicy.labels.allowed | toJson | quote }}
{{- end }}
{{- if and .Values.controller.admissionPolicy.labels.denied (gt (len .Values.controller.admissionPolicy.labels.denied) 0) }}
- name: AGENTS_CONTROLLER_LABELS_DENIED
  value: {{ .Values.controller.admissionPolicy.labels.denied | toJson | quote }}
{{- end }}
{{- if and .Values.controller.admissionPolicy.images.allowed (gt (len .Values.controller.admissionPolicy.images.allowed) 0) }}
- name: AGENTS_CONTROLLER_IMAGES_ALLOWED
  value: {{ .Values.controller.admissionPolicy.images.allowed | toJson | quote }}
{{- end }}
{{- if and .Values.controller.admissionPolicy.images.denied (gt (len .Values.controller.admissionPolicy.images.denied) 0) }}
- name: AGENTS_CONTROLLER_IMAGES_DENIED
  value: {{ .Values.controller.admissionPolicy.images.denied | toJson | quote }}
{{- end }}
{{- if and .Values.controller.admissionPolicy.secrets.blocked (gt (len .Values.controller.admissionPolicy.secrets.blocked) 0) }}
- name: AGENTS_CONTROLLER_BLOCKED_SECRETS
  value: {{ .Values.controller.admissionPolicy.secrets.blocked | toJson | quote }}
{{- end }}
{{- $vcsProvidersEnabled := true }}
{{- if and (hasKey .Values "controller") (hasKey .Values.controller "vcsProviders") (hasKey .Values.controller.vcsProviders "enabled") }}
{{- $vcsProvidersEnabled = .Values.controller.vcsProviders.enabled }}
{{- end }}
- name: AGENTS_CONTROLLER_VCS_PROVIDERS_ENABLED
  value: {{ $vcsProvidersEnabled | quote }}
{{- if .Values.controller.vcsProviders.deprecatedTokenTypes }}
- name: AGENTS_CONTROLLER_VCS_DEPRECATED_TOKEN_TYPES
  value: {{ .Values.controller.vcsProviders.deprecatedTokenTypes | toJson | quote }}
{{- end }}
{{- if and .Values.controller.vcsProviders.prRateLimits (gt (len .Values.controller.vcsProviders.prRateLimits) 0) }}
- name: AGENTS_CONTROLLER_VCS_PR_RATE_LIMITS
  value: {{ .Values.controller.vcsProviders.prRateLimits | toJson | quote }}
{{- end }}
{{- if .Values.controller.authSecret.name }}
- name: AGENTS_CONTROLLER_AUTH_SECRET_NAME
  value: {{ .Values.controller.authSecret.name | quote }}
- name: AGENTS_CONTROLLER_AUTH_SECRET_KEY
  value: {{ .Values.controller.authSecret.key | default "auth.json" | quote }}
- name: AGENTS_CONTROLLER_AUTH_SECRET_MOUNT_PATH
  value: {{ .Values.controller.authSecret.mountPath | default "/root/.codex" | quote }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}
