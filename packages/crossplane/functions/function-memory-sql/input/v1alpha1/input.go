// Package v1alpha1 contains the input type for this Function.
// +kubebuilder:object:generate=true
// +groupName=fn.proompteng.ai
// +versionName=v1alpha1
package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// MemorySqlRender provides input for rendering memory SQL templates.
// +kubebuilder:object:root=true
// +kubebuilder:storageversion
// +kubebuilder:resource:categories=crossplane
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="ConfigMap",type=string,JSONPath=`.spec.targetConfigMap`
// +kubebuilder:printcolumn:name="SQL Key",type=string,JSONPath=`.spec.sqlKey`
// +kubebuilder:printcolumn:name="Dimension",type=string,JSONPath=`.spec.embeddingsDimensionFieldPath`
type MemorySqlRender struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec MemorySqlRenderSpec `json:"spec"`
}

// DeepCopyObject implements runtime.Object.
func (in *MemorySqlRender) DeepCopyObject() runtime.Object {
	if in == nil {
		return nil
	}
	out := new(MemorySqlRender)
	*out = *in
	out.ObjectMeta = *in.DeepCopy()
	return out
}

// MemorySqlRenderSpec configures SQL template rendering.
type MemorySqlRenderSpec struct {
	TargetConfigMap              string `json:"targetConfigMap"`
	SqlKey                       string `json:"sqlKey"`
	EmbeddingsDimensionFieldPath string `json:"embeddingsDimensionFieldPath"`
}
