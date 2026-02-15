package v1alpha1

import (
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

const defaultStorageClass = "rook-ceph-block"

// TigerBeetleClusterSpec defines the desired state of a TigerBeetle cluster.
type TigerBeetleClusterSpec struct {
	// ClusterID is the numerical identifier for the TigerBeetle cluster.
	// +kubebuilder:validation:Pattern:=`^[0-9]+$`
	ClusterID string `json:"clusterID"`

	// Image is the container image to use for TigerBeetle nodes.
	// +kubebuilder:validation:MinLength=1
	Image string `json:"image"`

	// Port is the client port exposed by TigerBeetle.
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=65535
	Port int32 `json:"port"`

	// Replicas is the number of TigerBeetle replicas to run.
	// +kubebuilder:validation:Minimum=1
	Replicas int32 `json:"replicas"`

	// StorageClassName is the storage class backing the persistent volume claims.
	// +optional
	StorageClassName *string `json:"storageClassName,omitempty"`

	// StorageSize configures the persistent volume size for each replica.
	// +kubebuilder:validation:MinLength=2
	StorageSize resource.Quantity `json:"storageSize"`
}

// TigerBeetleClusterStatus captures the observed state of the TigerBeetle cluster.
type TigerBeetleClusterStatus struct {
	// ReadyReplicas reports the number of ready TigerBeetle replicas.
	// +optional
	ReadyReplicas int32 `json:"readyReplicas,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status

// TigerBeetleCluster is the schema for the TigerBeetle API.
type TigerBeetleCluster struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   TigerBeetleClusterSpec   `json:"spec,omitempty"`
	Status TigerBeetleClusterStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// TigerBeetleClusterList contains a list of TigerBeetleCluster resources.
type TigerBeetleClusterList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []TigerBeetleCluster `json:"items"`
}

// DeepCopyInto performs a deep copy of the receiver.
func (in *TigerBeetleCluster) DeepCopyInto(out *TigerBeetleCluster) {
	*out = *in
	out.TypeMeta = in.TypeMeta
	in.ObjectMeta.DeepCopyInto(&out.ObjectMeta)
	out.Spec = in.Spec
	if in.Spec.StorageClassName != nil {
		sc := *in.Spec.StorageClassName
		out.Spec.StorageClassName = &sc
	}
	in.Spec.StorageSize.DeepCopyInto(&out.Spec.StorageSize)
	out.Status = in.Status
}

// DeepCopy creates a deep copy of the receiver.
func (in *TigerBeetleCluster) DeepCopy() *TigerBeetleCluster {
	if in == nil {
		return nil
	}
	out := new(TigerBeetleCluster)
	in.DeepCopyInto(out)
	return out
}

// DeepCopyObject implements runtime.Object.
func (in *TigerBeetleCluster) DeepCopyObject() runtime.Object {
	if c := in.DeepCopy(); c != nil {
		return c
	}
	return nil
}

// DeepCopyInto performs a deep copy of the list receiver.
func (in *TigerBeetleClusterList) DeepCopyInto(out *TigerBeetleClusterList) {
	*out = *in
	out.TypeMeta = in.TypeMeta
	in.ListMeta.DeepCopyInto(&out.ListMeta)
	if in.Items != nil {
		out.Items = make([]TigerBeetleCluster, len(in.Items))
		for i := range in.Items {
			in.Items[i].DeepCopyInto(&out.Items[i])
		}
	}
}

// DeepCopy creates a deep copy of the list receiver.
func (in *TigerBeetleClusterList) DeepCopy() *TigerBeetleClusterList {
	if in == nil {
		return nil
	}
	out := new(TigerBeetleClusterList)
	in.DeepCopyInto(out)
	return out
}

// DeepCopyObject implements runtime.Object for the list type.
func (in *TigerBeetleClusterList) DeepCopyObject() runtime.Object {
	if c := in.DeepCopy(); c != nil {
		return c
	}
	return nil
}

// ApplyDefaults fills unset fields with safe defaults.
func (c *TigerBeetleCluster) ApplyDefaults() bool {
	updated := false

	if c.Spec.ClusterID == "" {
		c.Spec.ClusterID = "0"
		updated = true
	}

	if c.Spec.Image == "" {
		c.Spec.Image = "ghcr.io/tigerbeetle/tigerbeetle:0.16.60"
		updated = true
	}

	if c.Spec.Port == 0 {
		c.Spec.Port = 3000
		updated = true
	}

	if c.Spec.Replicas == 0 {
		c.Spec.Replicas = 3
		updated = true
	}

	if c.Spec.StorageSize.IsZero() {
		c.Spec.StorageSize = resource.MustParse("10Gi")
		updated = true
	}

	if c.Spec.StorageClassName == nil || *c.Spec.StorageClassName == "" {
		sc := defaultStorageClass
		if c.Spec.StorageClassName == nil || *c.Spec.StorageClassName != sc {
			c.Spec.StorageClassName = &sc
			updated = true
		}
	}

	return updated
}
