// +kubebuilder:object:generate=true

package v1alpha1

import (
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Image",type=string,JSONPath=`.spec.image`
type Tool struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   ToolSpec   `json:"spec,omitempty"`
	Status ToolStatus `json:"status,omitempty"`
}

type ToolSpec struct {
	Image                   string       `json:"image,omitempty"`
	Command                 []string     `json:"command,omitempty"`
	Args                    []string     `json:"args,omitempty"`
	Env                     []ToolEnvVar `json:"env,omitempty"`
	ServiceAccount          string       `json:"serviceAccount,omitempty"`
	WorkingDir              string       `json:"workingDir,omitempty"`
	TimeoutSeconds          int32        `json:"timeoutSeconds,omitempty"`
	TTLSecondsAfterFinished int32        `json:"ttlSecondsAfterFinished,omitempty"`
}

type ToolEnvVar struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type ToolStatus struct {
	ObservedGeneration int64              `json:"observedGeneration,omitempty"`
	UpdatedAt          *metav1.Time       `json:"updatedAt,omitempty"`
	Phase              string             `json:"phase,omitempty"`
	Conditions         []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
type ToolList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []Tool `json:"items"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Tool",type=string,JSONPath=`.spec.toolRef.name`
type ToolRun struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   ToolRunSpec   `json:"spec,omitempty"`
	Status ToolRunStatus `json:"status,omitempty"`
}

type ToolRunSpec struct {
	ToolRef    LocalRef          `json:"toolRef"`
	Parameters map[string]string `json:"parameters,omitempty"`
	DeliveryID string            `json:"deliveryId,omitempty"`
	// +kubebuilder:pruning:PreserveUnknownFields
	Runtime map[string]apiextensionsv1.JSON `json:"runtime,omitempty"`
}

type ToolRunStatus struct {
	ObservedGeneration int64        `json:"observedGeneration,omitempty"`
	UpdatedAt          *metav1.Time `json:"updatedAt,omitempty"`
	Phase              string       `json:"phase,omitempty"`
	RunID              string       `json:"runId,omitempty"`
	// +kubebuilder:pruning:PreserveUnknownFields
	RuntimeRef map[string]apiextensionsv1.JSON `json:"runtimeRef,omitempty"`
	StartedAt  *metav1.Time                    `json:"startedAt,omitempty"`
	FinishedAt *metav1.Time                    `json:"finishedAt,omitempty"`
	Conditions []metav1.Condition              `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
type ToolRunList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []ToolRun `json:"items"`
}

type LocalRef struct {
	Name string `json:"name"`
}
