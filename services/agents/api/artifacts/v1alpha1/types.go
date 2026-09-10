// +kubebuilder:object:generate=true

package v1alpha1

import metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="URI",type=string,JSONPath=`.status.uri`
type Artifact struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   ArtifactSpec   `json:"spec,omitempty"`
	Status ArtifactStatus `json:"status,omitempty"`
}

type ArtifactSpec struct {
	StorageRef *ArtifactStorageRef `json:"storageRef,omitempty"`
	Lifecycle  *ArtifactLifecycle  `json:"lifecycle,omitempty"`
}

type ArtifactStorageRef struct {
	Name string `json:"name,omitempty"`
}

type ArtifactLifecycle struct {
	TTLDays int32 `json:"ttlDays,omitempty"`
}

type ArtifactStatus struct {
	ObservedGeneration int64              `json:"observedGeneration,omitempty"`
	UpdatedAt          *metav1.Time       `json:"updatedAt,omitempty"`
	Phase              string             `json:"phase,omitempty"`
	URI                string             `json:"uri,omitempty"`
	Checksum           string             `json:"checksum,omitempty"`
	Conditions         []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
type ArtifactList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []Artifact `json:"items"`
}
