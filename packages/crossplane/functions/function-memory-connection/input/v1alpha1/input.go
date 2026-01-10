// Package v1alpha1 contains the input type for this Function.
// +kubebuilder:object:generate=true
// +groupName=fn.proompteng.ai
// +versionName=v1alpha1
package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// MemoryConnectionBinding provides input for binding provider connections.
// +kubebuilder:object:root=true
// +kubebuilder:storageversion
// +kubebuilder:resource:categories=crossplane
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Provider",type=string,JSONPath=`.spec.providerRefFieldPath`
// +kubebuilder:printcolumn:name="Job",type=string,JSONPath=`.spec.resources.job`
// +kubebuilder:printcolumn:name="ConfigMap",type=string,JSONPath=`.spec.resources.configMap`
type MemoryConnectionBinding struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec MemoryConnectionBindingSpec `json:"spec"`
}

// DeepCopyObject implements runtime.Object.
func (in *MemoryConnectionBinding) DeepCopyObject() runtime.Object {
	if in == nil {
		return nil
	}
	out := new(MemoryConnectionBinding)
	*out = *in
	out.ObjectMeta = *in.DeepCopy()
	return out
}

// MemoryConnectionBindingSpec configures how to bind provider connections.
type MemoryConnectionBindingSpec struct {
	ProviderRefFieldPath         string                           `json:"providerRefFieldPath"`
	Resources                    MemoryConnectionBindingResources `json:"resources"`
	TargetNamespaceFieldPaths    MemoryConnectionTargetNamespaces `json:"targetNamespaceFieldPaths"`
	DsnEnvVar                    string                           `json:"dsnEnvVar"`
	SchemaEnvVar                 string                           `json:"schemaEnvVar"`
	ConnectionSecretRefFieldPath string                           `json:"connectionSecretRefFieldPath"`
	StatusFieldPaths             MemoryConnectionStatusFieldPaths `json:"statusFieldPaths"`
}

// MemoryConnectionBindingResources identifies target composed resources.
type MemoryConnectionBindingResources struct {
	Job       string `json:"job"`
	ConfigMap string `json:"configMap"`
}

// MemoryConnectionTargetNamespaces identifies field paths to update namespaces.
type MemoryConnectionTargetNamespaces struct {
	Job       string `json:"job"`
	ConfigMap string `json:"configMap"`
}

// MemoryConnectionStatusFieldPaths provides composite status field paths.
type MemoryConnectionStatusFieldPaths struct {
	Endpoint string `json:"endpoint"`
	Database string `json:"database"`
	Schema   string `json:"schema"`
	Provider string `json:"provider"`
}
