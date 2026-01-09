// Package v1alpha1 contains the input type for this Function.
// +kubebuilder:object:generate=true
// +groupName=fn.proompteng.ai
// +versionName=v1alpha1
package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// MapToList provides input for converting a map into a list of key/value objects.
// +kubebuilder:object:root=true
// +kubebuilder:storageversion
// +kubebuilder:resource:categories=crossplane
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="From",type=string,JSONPath=`.spec.fromFieldPath`
// +kubebuilder:printcolumn:name="To",type=string,JSONPath=`.spec.toFieldPath`
// +kubebuilder:printcolumn:name="Resource",type=string,JSONPath=`.spec.toResource`
type MapToList struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec MapToListSpec `json:"spec"`
}

// DeepCopyObject implements runtime.Object.
func (in *MapToList) DeepCopyObject() runtime.Object {
	if in == nil {
		return nil
	}
	out := new(MapToList)
	*out = *in
	out.ObjectMeta = *in.ObjectMeta.DeepCopy()
	return out
}

// MapToListSpec configures the mapping.
type MapToListSpec struct {
	FromFieldPath string        `json:"fromFieldPath"`
	ToResource    string        `json:"toResource"`
	ToFieldPath   string        `json:"toFieldPath"`
	ListKeys      MapToListKeys `json:"listKeys"`
}

// MapToListKeys defines the key names in the output list items.
type MapToListKeys struct {
	NameField  string `json:"nameField"`
	ValueField string `json:"valueField"`
}
