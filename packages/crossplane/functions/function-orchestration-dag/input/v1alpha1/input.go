// Package v1alpha1 contains the input type for this Function.
// +kubebuilder:object:generate=true
// +groupName=fn.proompteng.ai
// +versionName=v1alpha1
package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// OrchestrationDag provides input for building Argo DAG tasks.
// +kubebuilder:object:root=true
// +kubebuilder:storageversion
// +kubebuilder:resource:categories=crossplane
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Steps",type=string,JSONPath=`.spec.stepsFieldPath`
// +kubebuilder:printcolumn:name="Entrypoint",type=string,JSONPath=`.spec.entrypointFieldPath`
// +kubebuilder:printcolumn:name="Template",type=string,JSONPath=`.spec.targetWorkflowTemplate`
type OrchestrationDag struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec OrchestrationDagSpec `json:"spec"`
}

// DeepCopyObject implements runtime.Object.
func (in *OrchestrationDag) DeepCopyObject() runtime.Object {
	if in == nil {
		return nil
	}
	out := new(OrchestrationDag)
	*out = *in
	out.ObjectMeta = *in.ObjectMeta.DeepCopy()
	return out
}

// OrchestrationDagSpec configures the DAG builder.
type OrchestrationDagSpec struct {
	StepsFieldPath         string `json:"stepsFieldPath"`
	EntrypointFieldPath    string `json:"entrypointFieldPath"`
	TargetWorkflowTemplate string `json:"targetWorkflowTemplate"`
}
