{{/*
Chart name (respects nameOverride).
*/}}
{{- define "arc-nanopayments.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully qualified app name (respects fullnameOverride / nameOverride).
*/}}
{{- define "arc-nanopayments.fullname" -}}
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

{{/*
Chart name and version, for the helm.sh/chart label.
*/}}
{{- define "arc-nanopayments.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels.
*/}}
{{- define "arc-nanopayments.labels" -}}
helm.sh/chart: {{ include "arc-nanopayments.chart" . }}
{{ include "arc-nanopayments.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: arc-nanopayments
{{- end -}}

{{/*
Selector labels.
*/}}
{{- define "arc-nanopayments.selectorLabels" -}}
app.kubernetes.io/name: {{ include "arc-nanopayments.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Component-scoped labels. Call with (dict "ctx" . "component" "seller").
*/}}
{{- define "arc-nanopayments.componentLabels" -}}
{{ include "arc-nanopayments.labels" .ctx }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/*
Component-scoped selector labels. Call with (dict "ctx" . "component" "seller").
*/}}
{{- define "arc-nanopayments.componentSelectorLabels" -}}
{{ include "arc-nanopayments.selectorLabels" .ctx }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/*
Fully qualified container image reference.
*/}}
{{- define "arc-nanopayments.image" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- printf "%s/%s:%s" .Values.image.registry .Values.image.repository $tag -}}
{{- end -}}

{{/*
imagePullSecrets list (YAML), empty when none configured.
*/}}
{{- define "arc-nanopayments.imagePullSecrets" -}}
{{- with .Values.image.pullSecrets }}
{{- toYaml . -}}
{{- end }}
{{- end -}}

{{/*
ServiceAccount name.
*/}}
{{- define "arc-nanopayments.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "arc-nanopayments.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
Shared ExternalSecret / synced Secret name.
*/}}
{{- define "arc-nanopayments.externalSecretName" -}}
{{- default (printf "%s-secrets" (include "arc-nanopayments.fullname" .)) .Values.externalSecret.target.name -}}
{{- end -}}

{{/*
Name of the PVC holding the seller's .trace event log.
*/}}
{{- define "arc-nanopayments.traceClaimName" -}}
{{- .Values.trace.existingClaim | default (printf "%s-trace" (include "arc-nanopayments.fullname" .)) -}}
{{- end -}}

{{/*
Volume for the .trace event log. Empty when trace is disabled, so callers guard
with `with (include ...)`.
*/}}
{{- define "arc-nanopayments.traceVolume" -}}
{{- if .Values.trace.enabled -}}
- name: trace
  persistentVolumeClaim:
    claimName: {{ include "arc-nanopayments.traceClaimName" . }}
{{- end -}}
{{- end -}}

{{/*
volumeMount for the .trace event log. Empty when trace is disabled.

The path is deliberately hardcoded, not a value: lib/x402.ts writes to the
relative ".trace/events" and app/api/trace/[tx]/route.ts reads
join(process.cwd(), ".trace", "events"), both resolved against the image's
WORKDIR /app. Mounting anywhere else leaves the volume empty while the app keeps
writing to the root-owned /app/.trace and failing open — a green deploy with a
permanently blank trace page.
*/}}
{{- define "arc-nanopayments.traceVolumeMount" -}}
{{- if .Values.trace.enabled -}}
- name: trace
  mountPath: /app/.trace
{{- end -}}
{{- end -}}

{{/*
Seller Service DNS name (in-cluster), used to derive the buyer's BASE_URL.
*/}}
{{- define "arc-nanopayments.sellerBaseUrl" -}}
{{- if .Values.buyer.baseUrl -}}
{{- .Values.buyer.baseUrl -}}
{{- else -}}
{{- printf "http://%s-seller:%d" (include "arc-nanopayments.fullname" .) (int .Values.seller.service.port) -}}
{{- end -}}
{{- end -}}
