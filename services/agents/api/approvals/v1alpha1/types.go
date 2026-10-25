// +kubebuilder:object:generate=true

package v1alpha1

import metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Mode",type=string,JSONPath=`.spec.mode`
type ApprovalPolicy struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   ApprovalPolicySpec   `json:"spec,omitempty"`
	Status ApprovalPolicyStatus `json:"status,omitempty"`
}

// +kubebuilder:pruning:PreserveUnknownFields
type ApprovalPolicySpec struct {
	Mode            string                  `json:"mode,omitempty"`
	DefaultDecision string                  `json:"defaultDecision,omitempty"`
	Subjects        []ApprovalPolicySubject `json:"subjects,omitempty"`
}

type ApprovalPolicySubject struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace,omitempty"`
}

type ApprovalPolicyStatus struct {
	ObservedGeneration int64              `json:"observedGeneration,omitempty"`
	UpdatedAt          *metav1.Time       `json:"updatedAt,omitempty"`
	Phase              string             `json:"phase,omitempty"`
	LastDecisionAt     *metav1.Time       `json:"lastDecisionAt,omitempty"`
	Conditions         []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
type ApprovalPolicyList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []ApprovalPolicy `json:"items"`
}
