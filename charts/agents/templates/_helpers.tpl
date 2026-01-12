{{- define "agents.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "agents.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "agents.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "agents.labels" -}}
app.kubernetes.io/name: {{ include "agents.name" . }}
helm.sh/chart: {{ include "agents.chart" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "agents.selectorLabels" -}}
app.kubernetes.io/name: {{ include "agents.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "agents.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- if .Values.serviceAccount.name -}}
{{- .Values.serviceAccount.name -}}
{{- else -}}
{{- printf "%s-sa" (include "agents.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "agents.postgres.fullname" -}}
{{- printf "%s-postgres" (include "agents.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "agents.databaseSecretName" -}}
{{- if .Values.externalDatabase.enabled -}}
{{- "" -}}
{{- else if .Values.postgres.credentials.existingSecret -}}
{{- .Values.postgres.credentials.existingSecret -}}
{{- else -}}
{{- printf "%s-db" (include "agents.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "agents.databaseUser" -}}
{{- if .Values.externalDatabase.enabled -}}
{{- .Values.externalDatabase.user | default "agents" -}}
{{- else -}}
{{- .Values.postgres.credentials.username | default "agents" -}}
{{- end -}}
{{- end -}}

{{- define "agents.databaseName" -}}
{{- if .Values.externalDatabase.enabled -}}
{{- .Values.externalDatabase.database | default "agents" -}}
{{- else -}}
{{- .Values.postgres.credentials.database | default "agents" -}}
{{- end -}}
{{- end -}}

{{- define "agents.databaseHost" -}}
{{- if .Values.externalDatabase.enabled -}}
{{- required "externalDatabase.host is required when externalDatabase.enabled" .Values.externalDatabase.host -}}
{{- else -}}
{{- printf "%s.%s.svc.cluster.local" (include "agents.postgres.fullname" .) (.Values.namespaceOverride | default .Release.Namespace) -}}
{{- end -}}
{{- end -}}

{{- define "agents.databasePort" -}}
{{- if .Values.externalDatabase.enabled -}}
{{- .Values.externalDatabase.port | default 5432 -}}
{{- else -}}
{{- .Values.postgres.service.port | default 5432 -}}
{{- end -}}
{{- end -}}

{{- define "agents.databasePassword" -}}
{{- if .Values.externalDatabase.enabled -}}
{{- if .Values.externalDatabase.passwordSecret.name -}}
{{- "" -}}
{{- else -}}
{{- .Values.externalDatabase.password | default "" -}}
{{- end -}}
{{- else if .Values.postgres.credentials.password -}}
{{- .Values.postgres.credentials.password -}}
{{- else -}}
{{- $secret := lookup "v1" "Secret" (.Values.namespaceOverride | default .Release.Namespace) (include "agents.databaseSecretName" .) -}}
{{- if $secret -}}
{{- index $secret.data "password" | b64dec -}}
{{- else -}}
{{- randAlphaNum 20 -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "agents.databaseUrl" -}}
{{- $user := include "agents.databaseUser" . -}}
{{- $pass := include "agents.databasePassword" . -}}
{{- $host := include "agents.databaseHost" . -}}
{{- $db := include "agents.databaseName" . -}}
{{- $port := include "agents.databasePort" . -}}
{{- $ssl := "disable" -}}
{{- if .Values.externalDatabase.enabled -}}
{{- $ssl = default "require" .Values.externalDatabase.sslMode -}}
{{- end -}}
{{- printf "postgresql://%s:%s@%s:%s/%s?sslmode=%s" $user $pass $host $port $db $ssl -}}
{{- end -}}

{{- define "agents.primitivesNamespaces" -}}
{{- $namespaces := .Values.primitives.namespaces | default (list) -}}
{{- if or (not $namespaces) (eq (len $namespaces) 0) -}}
{{- $namespaces = list (.Values.namespaceOverride | default .Release.Namespace) -}}
{{- end -}}
{{- join "," $namespaces -}}
{{- end -}}

{{- define "agents.postgresPassword" -}}
{{- if .Values.postgres.credentials.password -}}
{{- .Values.postgres.credentials.password -}}
{{- else -}}
{{- $secret := lookup "v1" "Secret" (.Values.namespaceOverride | default .Release.Namespace) (include "agents.databaseSecretName" .) -}}
{{- if $secret -}}
{{- index $secret.data "password" | b64dec -}}
{{- else -}}
{{- randAlphaNum 20 -}}
{{- end -}}
{{- end -}}
{{- end -}}
