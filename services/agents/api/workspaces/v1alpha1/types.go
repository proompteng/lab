// +kubebuilder:object:generate=true

package v1alpha1

import metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Volume",type=string,JSONPath=`.status.volumeName`
type Workspace struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   WorkspaceSpec   `json:"spec,omitempty"`
	Status WorkspaceStatus `json:"status,omitempty"`
}

type WorkspaceSpec struct {
	StorageClassName string   `json:"storageClassName,omitempty"`
	Size             string   `json:"size,omitempty"`
	AccessModes      []string `json:"accessModes,omitempty"`
	TTLSeconds       int32    `json:"ttlSeconds,omitempty"`
}

type WorkspaceStatus struct {
	ObservedGeneration int64              `json:"observedGeneration,omitempty"`
	UpdatedAt          *metav1.Time       `json:"updatedAt,omitempty"`
	Phase              string             `json:"phase,omitempty"`
	VolumeName         string             `json:"volumeName,omitempty"`
	Conditions         []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
type WorkspaceList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []Workspace `json:"items"`
}
