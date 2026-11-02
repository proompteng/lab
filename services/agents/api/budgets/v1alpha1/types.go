// +kubebuilder:object:generate=true

package v1alpha1

import metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
type Budget struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   BudgetSpec   `json:"spec,omitempty"`
	Status BudgetStatus `json:"status,omitempty"`
}

type BudgetSpec struct {
	// +kubebuilder:pruning:PreserveUnknownFields
	Limits *BudgetLimits `json:"limits,omitempty"`
}

type BudgetLimits struct {
	Tokens  string `json:"tokens,omitempty"`
	Dollars string `json:"dollars,omitempty"`
	CPU     string `json:"cpu,omitempty"`
	Memory  string `json:"memory,omitempty"`
	GPU     string `json:"gpu,omitempty"`
}

type BudgetStatus struct {
	ObservedGeneration int64              `json:"observedGeneration,omitempty"`
	UpdatedAt          *metav1.Time       `json:"updatedAt,omitempty"`
	Phase              string             `json:"phase,omitempty"`
	Used               *BudgetLimits      `json:"used,omitempty"`
	Conditions         []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
type BudgetList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []Budget `json:"items"`
}
