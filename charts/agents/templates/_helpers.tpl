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

{{- define "agents.controllersName" -}}
{{- printf "%s-controllers" (include "agents.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "agents.controllersSelectorLabels" -}}
app.kubernetes.io/name: {{ include "agents.controllersName" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "agents.rolloutChecksumAnnotations" -}}
{{- if not .Values.rolloutChecksums.enabled -}}
{{- else -}}
{{- $namespace := .Values.namespaceOverride | default .Release.Namespace -}}
{{- $annotations := dict -}}

{{- if and .Values.database.createSecret.enabled .Values.database.url -}}
{{- $dbSecretName := include "agents.databaseSecretName" . }}
{{- $annotations = set $annotations (printf "checksum/secret/%s/%s" $namespace $dbSecretName) (sha256sum .Values.database.url) -}}
{{- end -}}

{{- range .Values.rolloutChecksums.secrets -}}
{{- $secretName := .name | trim -}}
{{- $checksum := .checksum | trim -}}
{{- if and $secretName $checksum -}}
{{- $secretNamespace := default $namespace .namespace -}}
{{- $annotations = set $annotations (printf "checksum/secret/%s/%s" $secretNamespace $secretName) $checksum -}}
{{- end -}}
{{- end -}}

{{- range .Values.rolloutChecksums.configMaps -}}
{{- $configMapName := .name | trim -}}
{{- $checksum := .checksum | trim -}}
{{- if and $configMapName $checksum -}}
{{- $configMapNamespace := default $namespace .namespace -}}
{{- $annotations = set $annotations (printf "checksum/configmap/%s/%s" $configMapNamespace $configMapName) $checksum -}}
{{- end -}}
{{- end -}}

{{- if gt (len $annotations) 0 -}}
{{- range $annotationKey := sortAlpha (keys $annotations) -}}
{{- printf "%s: %s\n" $annotationKey (index $annotations $annotationKey | quote) -}}
{{- end -}}
{{- end -}}
{{- end -}}
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

{{- define "agents.runnerServiceAccountName" -}}
{{- if .Values.runnerServiceAccount.name -}}
{{- .Values.runnerServiceAccount.name -}}
{{- else if .Values.runnerServiceAccount.create -}}
{{- printf "%s-runner" (include "agents.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "agents.databaseSecretName" -}}
{{- if .Values.database.createSecret.enabled -}}
{{- if .Values.database.createSecret.name -}}
{{- .Values.database.createSecret.name -}}
{{- else -}}
{{- printf "%s-db" (include "agents.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- else -}}
{{- .Values.database.secretRef.name -}}
{{- end -}}
{{- end -}}

{{- define "agents.databaseSecretKey" -}}
{{- if .Values.database.createSecret.enabled -}}
url
{{- else -}}
{{- .Values.database.secretRef.key | default "url" -}}
{{- end -}}
{{- end -}}

{{- define "agents.controllerNamespaces" -}}
{{- $namespaces := .Values.controller.namespaces | default (list) -}}
{{- if or (not $namespaces) (eq (len $namespaces) 0) -}}
{{- $namespaces = list (.Values.namespaceOverride | default .Release.Namespace) -}}
{{- end -}}
{{- join "," $namespaces -}}
{{- end -}}

{{- define "agents.orchestrationNamespaces" -}}
{{- $namespaces := .Values.orchestrationController.namespaces | default (list) -}}
{{- if or (not $namespaces) (eq (len $namespaces) 0) -}}
{{- $namespaces = list (.Values.namespaceOverride | default .Release.Namespace) -}}
{{- end -}}
{{- join "," $namespaces -}}
{{- end -}}

{{- define "agents.supportingNamespaces" -}}
{{- $namespaces := .Values.supportingController.namespaces | default (list) -}}
{{- if or (not $namespaces) (eq (len $namespaces) 0) -}}
{{- $namespaces = list (.Values.namespaceOverride | default .Release.Namespace) -}}
{{- end -}}
{{- join "," $namespaces -}}
{{- end -}}
