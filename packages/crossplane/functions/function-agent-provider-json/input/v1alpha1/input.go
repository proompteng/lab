// Package v1alpha1 contains the input type for this Function.
// +kubebuilder:object:generate=true
// +groupName=fn.proompteng.ai
// +versionName=v1alpha1
package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// AgentProviderJson provides input for rendering agent provider JSON.
// +kubebuilder:object:root=true
// +kubebuilder:storageversion
// +kubebuilder:resource:categories=crossplane
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="ConfigMap",type=string,JSONPath=`.spec.targetConfigMap`
// +kubebuilder:printcolumn:name="JSON Key",type=string,JSONPath=`.spec.jsonKey`
//
//nolint:revive // CRD naming uses Json to align with existing API.
type AgentProviderJson struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec AgentProviderJsonSpec `json:"spec"`
}

// DeepCopyObject implements runtime.Object.
func (in *AgentProviderJson) DeepCopyObject() runtime.Object {
	if in == nil {
		return nil
	}
	out := new(AgentProviderJson)
	*out = *in
	out.ObjectMeta = *in.DeepCopy()
	return out
}

// AgentProviderJsonSpec configures provider JSON rendering.
//
//nolint:revive // CRD naming uses Json to align with existing API.
type AgentProviderJsonSpec struct {
	TargetConfigMap string `json:"targetConfigMap"`
	JsonKey         string `json:"jsonKey,omitempty"` //nolint:revive // JSONKey matches JSON field naming.
}
