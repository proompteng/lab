// Package v1alpha1 contains the input type for this Function.
// +kubebuilder:object:generate=true
// +groupName=fn.proompteng.ai
// +versionName=v1alpha1
package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// OrchestrationStatus provides input for mapping workflow status into stepStatuses.
// +kubebuilder:object:root=true
// +kubebuilder:storageversion
// +kubebuilder:resource:categories=crossplane
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Workflow",type=string,JSONPath=`.spec.workflowResource`
// +kubebuilder:printcolumn:name="StepStatuses",type=string,JSONPath=`.spec.stepStatusesFieldPath`
// +kubebuilder:printcolumn:name="Nodes",type=string,JSONPath=`.spec.nodesFieldPath`
type OrchestrationStatus struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec OrchestrationStatusSpec `json:"spec"`
}

// DeepCopyObject implements runtime.Object.
func (in *OrchestrationStatus) DeepCopyObject() runtime.Object {
	if in == nil {
		return nil
	}
	out := new(OrchestrationStatus)
	*out = *in
	out.ObjectMeta = *in.DeepCopy()
	return out
}

// OrchestrationStatusSpec configures workflow status mapping.
type OrchestrationStatusSpec struct {
	WorkflowResource      string `json:"workflowResource"`
	StepStatusesFieldPath string `json:"stepStatusesFieldPath"`
	NodesFieldPath        string `json:"nodesFieldPath,omitempty"`
}
