// +kubebuilder:object:generate=true

package v1alpha1

import (
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Entrypoint",type=string,JSONPath=`.spec.entrypoint`
type Orchestration struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   OrchestrationSpec   `json:"spec,omitempty"`
	Status OrchestrationStatus `json:"status,omitempty"`
}

type OrchestrationSpec struct {
	Entrypoint string              `json:"entrypoint,omitempty"`
	Steps      []OrchestrationStep `json:"steps"`
	// +kubebuilder:pruning:PreserveUnknownFields
	Policies map[string]apiextensionsv1.JSON `json:"policies,omitempty"`
}

// +kubebuilder:pruning:PreserveUnknownFields
type OrchestrationStep struct {
	Name                string            `json:"name"`
	Kind                string            `json:"kind"`
	DependsOn           []string          `json:"dependsOn,omitempty"`
	AgentRef            *LocalRef         `json:"agentRef,omitempty"`
	ToolRef             *LocalRef         `json:"toolRef,omitempty"`
	OrchestrationRef    *LocalRef         `json:"orchestrationRef,omitempty"`
	PolicyRef           string            `json:"policyRef,omitempty"`
	With                map[string]string `json:"with,omitempty"`
	Retries             int32             `json:"retries,omitempty"`
	RetryBackoffSeconds int32             `json:"retryBackoffSeconds,omitempty"`
	TimeoutSeconds      int32             `json:"timeoutSeconds,omitempty"`
}

type OrchestrationStatus struct {
	ObservedGeneration int64              `json:"observedGeneration,omitempty"`
	UpdatedAt          *metav1.Time       `json:"updatedAt,omitempty"`
	Phase              string             `json:"phase,omitempty"`
	Conditions         []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
type OrchestrationList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []Orchestration `json:"items"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Orchestration",type=string,JSONPath=`.spec.orchestrationRef.name`
// +kubebuilder:printcolumn:name="RunId",type=string,JSONPath=`.status.runId`
type OrchestrationRun struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   OrchestrationRunSpec   `json:"spec,omitempty"`
	Status OrchestrationRunStatus `json:"status,omitempty"`
}

type OrchestrationRunSpec struct {
	OrchestrationRef LocalRef          `json:"orchestrationRef"`
	Parameters       map[string]string `json:"parameters,omitempty"`
	DeliveryID       string            `json:"deliveryId,omitempty"`
}

type OrchestrationRunStatus struct {
	ObservedGeneration int64                             `json:"observedGeneration,omitempty"`
	UpdatedAt          *metav1.Time                      `json:"updatedAt,omitempty"`
	Phase              string                            `json:"phase,omitempty"`
	RunID              string                            `json:"runId,omitempty"`
	StartedAt          *metav1.Time                      `json:"startedAt,omitempty"`
	FinishedAt         *metav1.Time                      `json:"finishedAt,omitempty"`
	StepStatuses       []map[string]apiextensionsv1.JSON `json:"stepStatuses,omitempty"`
	Conditions         []metav1.Condition                `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
type OrchestrationRunList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []OrchestrationRun `json:"items"`
}

type LocalRef struct {
	Name string `json:"name"`
}
