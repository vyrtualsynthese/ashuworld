{{/*
Helpers shared by every template in the chart.

The component helpers take a dict instead of the root context, because a Deployment template
is inside a `range`-free scope but still needs to name a sibling component:
  {{ include "ashuworld.selectorLabels" (dict "root" . "component" "api") }}
*/}}

{{/* The chart name, or the override. */}}
{{- define "ashuworld.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
The release-qualified name. A release called "ashuworld" gets "ashuworld", not
"ashuworld-ashuworld": the chart name is already in the release name, and repeating it makes
Service names unreadable in `kubectl get svc`.
*/}}
{{- define "ashuworld.fullname" -}}
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

{{/* Labels for every object in the release. */}}
{{- define "ashuworld.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "ashuworld.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Selector labels for one component. These are the labels a Deployment's selector and its
pod template must share, so they stay stable while the release labels above can change.
*/}}
{{- define "ashuworld.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ashuworld.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* The Service name of the api, which the ingress, the web proxy and the probes refer to. */}}
{{- define "ashuworld.apiServiceName" -}}
{{- printf "%s-api" (include "ashuworld.fullname" .) -}}
{{- end -}}

{{/*
The image reference for one component: the repository from its values, and the tag from the
component, then the shared image.tag, then the chart's appVersion.
*/}}
{{- define "ashuworld.image" -}}
{{- $image := index .root.Values .component "image" -}}
{{- $tag := $image.tag | default .root.Values.image.tag | default .root.Chart.AppVersion -}}
{{- printf "%s:%s" $image.repository $tag -}}
{{- end -}}

{{/*
DATABASE_URL, read from the operator's Secret. It is defined once because five workloads
need it and a literal URL in any one of them would be the mistake this chart exists to
prevent.
*/}}
{{- define "ashuworld.databaseUrlEnv" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ required "postgres.secretName is required" .Values.postgres.secretName }}
      key: {{ required "postgres.urlKey is required" .Values.postgres.urlKey }}
{{- end -}}

{{/*
The erasure pepper, read from the operator's Secret. Defined once because the api, the worker
and the purge CronJob all erase or read erased rows, and a literal value in any one of them
would put the pepper into `helm get manifest` and the release's stored values.
*/}}
{{- define "ashuworld.erasurePepperEnv" -}}
- name: ERASURE_PEPPER
  valueFrom:
    secretKeyRef:
      name: {{ required "erasure.pepperSecretName is required" .Values.erasure.pepperSecretName }}
      key: {{ required "erasure.pepperKey is required" .Values.erasure.pepperKey }}
{{- end -}}

{{/*
The provider credentials, read from the operator's Secret. Defined once because the api and
the worker read overlapping but different keys, and two hand-written lists in two templates
would drift: the worker would gain a credential the api never got, or one of them would forget
`optional: true`.

The api reads the client pair; the worker reads that pair plus the channel's refresh token and
the key that seals it. Every `secretKeyRef` is optional on purpose: an absent key is how the
operator says "this provider is off", and the pod must still start. The channel login is the
one value that is not a credential, so it is plain environment, and it is left out entirely
when it is empty rather than rendered as an empty string that the code would have to reject.
*/}}
{{- define "ashuworld.providerEnv" -}}
{{- $secretName := .root.Values.providers.secretName -}}
{{- $channelLogin := .root.Values.providers.twitch.channelLogin -}}
{{- if $secretName -}}
- name: TWITCH_CLIENT_ID
  valueFrom:
    secretKeyRef:
      name: {{ $secretName }}
      key: twitch-client-id
      optional: true
- name: TWITCH_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ $secretName }}
      key: twitch-client-secret
      optional: true
{{- if eq .component "worker" }}
- name: TWITCH_CHANNEL_REFRESH_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ $secretName }}
      key: twitch-channel-token
      optional: true
- name: PLATFORM_TOKEN_KEY
  valueFrom:
    secretKeyRef:
      name: {{ $secretName }}
      key: platform-token-key
      optional: true
{{- end -}}
{{- end -}}
{{- if $channelLogin }}
- name: TWITCH_CHANNEL_LOGIN
  value: {{ $channelLogin | quote }}
{{- end -}}
{{- end -}}

{{/*
The URL the browser uses. Built from the ingress host rather than configured separately:
two values that must agree are two values that will not, and PUBLIC_BASE_URL decides the
Secure flag on the session cookie.
*/}}
{{- define "ashuworld.publicBaseUrl" -}}
{{- printf "%s://%s" (default "https" .Values.ingress.scheme) (required "ingress.host is required: set it to the hostname users will open" .Values.ingress.host) -}}
{{- end -}}

{{/* The Secret name holding the alpha reset confirm value. */}}
{{- define "ashuworld.resetSecretName" -}}
{{- .Values.alphaReset.secretName | default (printf "%s-reset" (include "ashuworld.fullname" .)) -}}
{{- end -}}

{{/* The Secret name holding the purge confirm value: the operator's, or the chart's. */}}
{{- define "ashuworld.purgeSecretName" -}}
{{- .Values.purge.secretName | default (printf "%s-purge" (include "ashuworld.fullname" .)) -}}
{{- end -}}
