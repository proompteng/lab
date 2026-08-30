// +kubebuilder:object:generate=true

package v1alpha1

import metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
type SecretBinding struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   SecretBindingSpec   `json:"spec,omitempty"`
	Status SecretBindingStatus `json:"status,omitempty"`
}

type SecretBindingSpec struct {
	Subjects       []SecretBindingSubject `json:"subjects,omitempty"`
	AllowedSecrets []string               `json:"allowedSecrets,omitempty"`
}

type SecretBindingSubject struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace,omitempty"`
}

type SecretBindingStatus struct {
	ObservedGeneration int64              `json:"observedGeneration,omitempty"`
	UpdatedAt          *metav1.Time       `json:"updatedAt,omitempty"`
	Phase              string             `json:"phase,omitempty"`
	Conditions         []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
type SecretBindingList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []SecretBinding `json:"items"`
}
