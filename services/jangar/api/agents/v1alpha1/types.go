// +kubebuilder:object:generate=true

package v1alpha1

import (
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.conditions[?(@.type=="Ready")].status`
// +kubebuilder:printcolumn:name="Provider",type=string,JSONPath=`.spec.providerRef.name`
type Agent struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   AgentSpec   `json:"spec"`
	Status AgentStatus `json:"status,omitempty"`
}

type AgentSpec struct {
	ProviderRef LocalRef `json:"providerRef"`
	// +kubebuilder:pruning:PreserveUnknownFields
	Config    map[string]apiextensionsv1.JSON `json:"config,omitempty"`
	Env       []AgentEnvVar                   `json:"env,omitempty"`
	Security  *AgentSecurity                  `json:"security,omitempty"`
	MemoryRef *LocalRef                       `json:"memoryRef,omitempty"`
	Defaults  *AgentRunDefaults               `json:"defaults,omitempty"`
}

type AgentEnvVar struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type AgentSecurity struct {
	AllowedServiceAccounts []string `json:"allowedServiceAccounts,omitempty"`
	AllowedSecrets         []string `json:"allowedSecrets,omitempty"`
}

type AgentRunDefaults struct {
	// +kubebuilder:validation:Minimum=0
	TimeoutSeconds int32 `json:"timeoutSeconds,omitempty"`
	// +kubebuilder:validation:Minimum=0
	RetryLimit int32 `json:"retryLimit,omitempty"`
}

type AgentStatus struct {
	Conditions         []metav1.Condition `json:"conditions,omitempty"`
	ObservedGeneration int64              `json:"observedGeneration,omitempty"`
}

// +kubebuilder:object:root=true
type AgentList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []Agent `json:"items"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Agent",type=string,JSONPath=`.spec.agentRef.name`
// +kubebuilder:printcolumn:name="Succeeded",type=string,JSONPath=`.status.conditions[?(@.type=="Succeeded")].status`
// +kubebuilder:printcolumn:name="Reason",type=string,JSONPath=`.status.conditions[?(@.type=="Succeeded")].reason`
// +kubebuilder:printcolumn:name="StartTime",type=date,JSONPath=`.status.startedAt`
// +kubebuilder:printcolumn:name="CompletionTime",type=date,JSONPath=`.status.finishedAt`
// +kubebuilder:printcolumn:name="Runtime",type=string,JSONPath=`.spec.runtime.type`
type AgentRun struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   AgentRunSpec   `json:"spec"`
	Status AgentRunStatus `json:"status,omitempty"`
}

// +kubebuilder:validation:XValidation:rule="has(self.implementationSpecRef) || has(self.implementation)",message="spec.implementationSpecRef or spec.implementation is required"
type AgentRunSpec struct {
	AgentRef              LocalRef              `json:"agentRef"`
	ImplementationSpecRef *LocalRef             `json:"implementationSpecRef,omitempty"`
	Implementation        *InlineImplementation `json:"implementation,omitempty"`
	Runtime               RuntimeSpec           `json:"runtime"`
	Workload              *WorkloadSpec         `json:"workload,omitempty"`
	// +kubebuilder:validation:MaxProperties=100
	Parameters     map[string]string `json:"parameters,omitempty"`
	Secrets        []string          `json:"secrets,omitempty"`
	MemoryRef      *LocalRef         `json:"memoryRef,omitempty"`
	IdempotencyKey string            `json:"idempotencyKey,omitempty"`
}

type InlineImplementation struct {
	Inline ImplementationSpecFields `json:"inline"`
}

type RuntimeSpec struct {
	// +kubebuilder:validation:Enum=argo;temporal;job;custom
	Type string `json:"type"`
	// +kubebuilder:pruning:PreserveUnknownFields
	Config map[string]apiextensionsv1.JSON `json:"config,omitempty"`
}

type WorkloadSpec struct {
	Image     string             `json:"image,omitempty"`
	Resources *WorkloadResources `json:"resources,omitempty"`
	Volumes   []WorkloadVolume   `json:"volumes,omitempty"`
}

type WorkloadResources struct {
	Requests map[string]string `json:"requests,omitempty"`
	Limits   map[string]string `json:"limits,omitempty"`
}

type WorkloadVolume struct {
	// +kubebuilder:validation:Enum=emptyDir;pvc;secret
	Type       string `json:"type"`
	Name       string `json:"name"`
	MountPath  string `json:"mountPath"`
	ReadOnly   bool   `json:"readOnly,omitempty"`
	ClaimName  string `json:"claimName,omitempty"`
	SecretName string `json:"secretName,omitempty"`
	SizeLimit  string `json:"sizeLimit,omitempty"`
	Medium     string `json:"medium,omitempty"`
}

type AgentRunStatus struct {
	Phase string `json:"phase,omitempty"`
	// +kubebuilder:pruning:PreserveUnknownFields
	RuntimeRef         map[string]apiextensionsv1.JSON `json:"runtimeRef,omitempty"`
	StartedAt          *metav1.Time                    `json:"startedAt,omitempty"`
	FinishedAt         *metav1.Time                    `json:"finishedAt,omitempty"`
	Artifacts          []Artifact                      `json:"artifacts,omitempty"`
	Conditions         []metav1.Condition              `json:"conditions,omitempty"`
	ObservedGeneration int64                           `json:"observedGeneration,omitempty"`
}

// +kubebuilder:object:root=true
type AgentRunList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []AgentRun `json:"items"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.conditions[?(@.type=="Ready")].status`
type AgentProvider struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   AgentProviderSpec   `json:"spec"`
	Status AgentProviderStatus `json:"status,omitempty"`
}

type AgentProviderSpec struct {
	Binary          string            `json:"binary"`
	ArgsTemplate    []string          `json:"argsTemplate,omitempty"`
	EnvTemplate     map[string]string `json:"envTemplate,omitempty"`
	InputFiles      []InputFile       `json:"inputFiles,omitempty"`
	OutputArtifacts []Artifact        `json:"outputArtifacts,omitempty"`
}

type InputFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type Artifact struct {
	Name string `json:"name"`
	Path string `json:"path,omitempty"`
	Key  string `json:"key,omitempty"`
	URL  string `json:"url,omitempty"`
}

type AgentProviderStatus struct {
	Conditions         []metav1.Condition `json:"conditions,omitempty"`
	ObservedGeneration int64              `json:"observedGeneration,omitempty"`
}

// +kubebuilder:object:root=true
type AgentProviderList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []AgentProvider `json:"items"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.conditions[?(@.type=="Ready")].status`
// +kubebuilder:printcolumn:name="Source",type=string,JSONPath=`.spec.source.provider`
// +kubebuilder:printcolumn:name="Updated",type=date,JSONPath=`.status.syncedAt`
type ImplementationSpec struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   ImplementationSpecFields `json:"spec"`
	Status ImplementationSpecStatus `json:"status,omitempty"`
}

type ImplementationSpecFields struct {
	Source *ImplementationSourceRef `json:"source,omitempty"`
	// +kubebuilder:validation:MaxLength=131072
	Text string `json:"text"`
	// +kubebuilder:validation:MaxLength=256
	Summary string `json:"summary,omitempty"`
	// +kubebuilder:validation:MaxLength=131072
	Description string `json:"description,omitempty"`
	// +kubebuilder:validation:MaxItems=50
	AcceptanceCriteria []string `json:"acceptanceCriteria,omitempty"`
	Labels             []string `json:"labels,omitempty"`
}

type ImplementationSourceRef struct {
	// +kubebuilder:validation:Enum=github;linear;manual;custom
	Provider   string `json:"provider"`
	ExternalId string `json:"externalId,omitempty"`
	URL        string `json:"url,omitempty"`
}

type ImplementationSpecStatus struct {
	SyncedAt           *metav1.Time       `json:"syncedAt,omitempty"`
	SourceVersion      string             `json:"sourceVersion,omitempty"`
	Conditions         []metav1.Condition `json:"conditions,omitempty"`
	ObservedGeneration int64              `json:"observedGeneration,omitempty"`
}

// +kubebuilder:object:root=true
type ImplementationSpecList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []ImplementationSpec `json:"items"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.conditions[?(@.type=="Ready")].status`
// +kubebuilder:printcolumn:name="Provider",type=string,JSONPath=`.spec.provider`
// +kubebuilder:printcolumn:name="LastSync",type=date,JSONPath=`.status.lastSyncedAt`
type ImplementationSource struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   ImplementationSourceSpec   `json:"spec"`
	Status ImplementationSourceStatus `json:"status,omitempty"`
}

type ImplementationSourceSpec struct {
	// +kubebuilder:validation:Enum=github;linear
	Provider string                       `json:"provider"`
	Auth     ImplementationSourceAuth     `json:"auth"`
	Webhook  *ImplementationSourceWebhook `json:"webhook,omitempty"`
	Poll     *ImplementationSourcePoll    `json:"poll,omitempty"`
	Scope    *ImplementationScope         `json:"scope,omitempty"`
	Mapping  map[string]string            `json:"mapping,omitempty"`
}

type ImplementationSourceAuth struct {
	SecretRef SecretRef `json:"secretRef"`
}

type ImplementationSourceWebhook struct {
	// +kubebuilder:default=false
	Enabled bool `json:"enabled,omitempty"`
}

type ImplementationSourcePoll struct {
	// +kubebuilder:validation:Minimum=30
	// +kubebuilder:default=60
	IntervalSeconds int32 `json:"intervalSeconds,omitempty"`
}

type ImplementationScope struct {
	Organization string   `json:"organization,omitempty"`
	Repository   string   `json:"repository,omitempty"`
	Project      string   `json:"project,omitempty"`
	Team         string   `json:"team,omitempty"`
	Labels       []string `json:"labels,omitempty"`
	Query        string   `json:"query,omitempty"`
}

type ImplementationSourceStatus struct {
	Cursor             string             `json:"cursor,omitempty"`
	LastSyncedAt       *metav1.Time       `json:"lastSyncedAt,omitempty"`
	Conditions         []metav1.Condition `json:"conditions,omitempty"`
	ObservedGeneration int64              `json:"observedGeneration,omitempty"`
}

// +kubebuilder:object:root=true
type ImplementationSourceList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []ImplementationSource `json:"items"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.conditions[?(@.type=="Ready")].status`
// +kubebuilder:printcolumn:name="Type",type=string,JSONPath=`.spec.type`
// +kubebuilder:printcolumn:name="Default",type=boolean,JSONPath=`.spec.default`
type Memory struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   MemorySpec   `json:"spec"`
	Status MemoryStatus `json:"status,omitempty"`
}

type MemorySpec struct {
	// +kubebuilder:validation:Enum=postgres;redis;weaviate;pinecone;custom
	Type       string           `json:"type"`
	Connection MemoryConnection `json:"connection"`
	// +kubebuilder:validation:Items:Enum=vector;kv;blob
	Capabilities []string `json:"capabilities,omitempty"`
	// +kubebuilder:default=false
	Default bool `json:"default,omitempty"`
}

type MemoryConnection struct {
	SecretRef SecretRef `json:"secretRef"`
}

type MemoryStatus struct {
	LastCheckedAt      *metav1.Time       `json:"lastCheckedAt,omitempty"`
	Conditions         []metav1.Condition `json:"conditions,omitempty"`
	ObservedGeneration int64              `json:"observedGeneration,omitempty"`
}

// +kubebuilder:object:root=true
type MemoryList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []Memory `json:"items"`
}

type SecretRef struct {
	Name string `json:"name"`
	Key  string `json:"key,omitempty"`
}

type LocalRef struct {
	Name string `json:"name"`
}
