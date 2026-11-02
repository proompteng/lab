// +kubebuilder:object:generate=true

package v1alpha1

import (
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
type Signal struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   SignalSpec   `json:"spec,omitempty"`
	Status SignalStatus `json:"status,omitempty"`
}

// +kubebuilder:pruning:PreserveUnknownFields
type SignalSpec struct {
	Channel     string `json:"channel,omitempty"`
	Description string `json:"description,omitempty"`
	// +kubebuilder:pruning:PreserveUnknownFields
	Payload map[string]apiextensionsv1.JSON `json:"payload,omitempty"`
}

type SignalStatus struct {
	ObservedGeneration int64              `json:"observedGeneration,omitempty"`
	UpdatedAt          *metav1.Time       `json:"updatedAt,omitempty"`
	Phase              string             `json:"phase,omitempty"`
	LastDeliveryAt     *metav1.Time       `json:"lastDeliveryAt,omitempty"`
	Conditions         []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
type SignalList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []Signal `json:"items"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Signal",type=string,JSONPath=`.spec.signalRef.name`
type SignalDelivery struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   SignalDeliverySpec   `json:"spec,omitempty"`
	Status SignalDeliveryStatus `json:"status,omitempty"`
}

type SignalDeliverySpec struct {
	SignalRef  LocalRef `json:"signalRef"`
	DeliveryID string   `json:"deliveryId,omitempty"`
	// +kubebuilder:pruning:PreserveUnknownFields
	Payload map[string]apiextensionsv1.JSON `json:"payload,omitempty"`
}

type SignalDeliveryStatus struct {
	ObservedGeneration int64              `json:"observedGeneration,omitempty"`
	UpdatedAt          *metav1.Time       `json:"updatedAt,omitempty"`
	Phase              string             `json:"phase,omitempty"`
	DeliveredAt        *metav1.Time       `json:"deliveredAt,omitempty"`
	Conditions         []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
type SignalDeliveryList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []SignalDelivery `json:"items"`
}

type LocalRef struct {
	Name string `json:"name"`
}
