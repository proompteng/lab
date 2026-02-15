package controller

import (
	"context"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"

	v1alpha1 "github.com/proompteng/lab/services/tigresse/api/v1alpha1"
)

func TestReconcileCreatesResources(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatalf("failed to add corev1 to scheme: %v", err)
	}
	if err := appsv1.AddToScheme(scheme); err != nil {
		t.Fatalf("failed to add appsv1 to scheme: %v", err)
	}
	if err := v1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("failed to add custom api to scheme: %v", err)
	}

	cluster := &v1alpha1.TigerBeetleCluster{}
	cluster.Name = "tigerbeetle"
	cluster.Namespace = "tigerbeetle"
	cluster.Spec = v1alpha1.TigerBeetleClusterSpec{
		ClusterID:   "0",
		Image:       "ghcr.io/tigerbeetle/tigerbeetle:0.16.60",
		Port:        3000,
		Replicas:    3,
		StorageSize: resource.MustParse("10Gi"),
	}

	client := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&v1alpha1.TigerBeetleCluster{}).WithObjects(cluster).Build()

	reconciler := &TigerBeetleClusterReconciler{
		Client: client,
		Scheme: scheme,
	}

	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&zap.Options{Development: true})))

	_, err := reconciler.Reconcile(context.Background(), ctrl.Request{NamespacedName: types.NamespacedName{Name: cluster.Name, Namespace: cluster.Namespace}})
	if err != nil {
		t.Fatalf("reconcile failed: %v", err)
	}

	// ConfigMap assertion
	cm := &corev1.ConfigMap{}
	if err := client.Get(context.Background(), types.NamespacedName{Name: "tigerbeetle-start-script", Namespace: cluster.Namespace}, cm); err != nil {
		t.Fatalf("expected configmap to be created: %v", err)
	}

	// Service assertion
	svc := &corev1.Service{}
	if err := client.Get(context.Background(), types.NamespacedName{Name: "tigerbeetle", Namespace: cluster.Namespace}, svc); err != nil {
		t.Fatalf("expected service to be created: %v", err)
	}

	// StatefulSet assertion
	sts := &appsv1.StatefulSet{}
	if err := client.Get(context.Background(), types.NamespacedName{Name: "tigerbeetle", Namespace: cluster.Namespace}, sts); err != nil {
		t.Fatalf("expected statefulset to be created: %v", err)
	}

	if sts.Spec.Replicas == nil || *sts.Spec.Replicas != 3 {
		t.Fatalf("expected statefulset replicas to equal 3")
	}

	if sts.Spec.VolumeClaimTemplates[0].Spec.StorageClassName == nil {
		t.Fatalf("expected storage class default to be applied")
	}
	if sc := *sts.Spec.VolumeClaimTemplates[0].Spec.StorageClassName; sc != "rook-ceph-block" {
		t.Fatalf("expected default storage class rook-ceph-block, got %s", sc)
	}

	// Status update path
	sts.Status.ReadyReplicas = 2
	if err := client.Status().Update(context.Background(), sts); err != nil {
		t.Fatalf("failed to update sts status: %v", err)
	}

	if _, err := reconciler.Reconcile(context.Background(), ctrl.Request{NamespacedName: types.NamespacedName{Name: cluster.Name, Namespace: cluster.Namespace}}); err != nil {
		t.Fatalf("reconcile failed: %v", err)
	}

	updatedCluster := &v1alpha1.TigerBeetleCluster{}
	if err := client.Get(context.Background(), types.NamespacedName{Name: cluster.Name, Namespace: cluster.Namespace}, updatedCluster); err != nil {
		t.Fatalf("expected cluster to be retrievable: %v", err)
	}

	if updatedCluster.Status.ReadyReplicas != 2 {
		t.Fatalf("expected status to reflect ready replicas")
	}
}

func TestApplyDefaults(t *testing.T) {
	cluster := &v1alpha1.TigerBeetleCluster{}
	cluster.Spec.StorageSize = resource.MustParse("0")

	if updated := cluster.ApplyDefaults(); !updated {
		t.Fatalf("expected defaults to apply")
	}

	if cluster.Spec.Image == "" || cluster.Spec.ClusterID == "" || cluster.Spec.Port == 0 || cluster.Spec.Replicas == 0 {
		t.Fatalf("expected defaults to populate required fields")
	}

	if cluster.Spec.StorageSize.IsZero() {
		t.Fatalf("expected storage default to be applied")
	}

	if cluster.Spec.StorageClassName == nil || *cluster.Spec.StorageClassName != "rook-ceph-block" {
		t.Fatalf("expected default storage class to be rook-ceph-block")
	}

	if updated := cluster.ApplyDefaults(); updated {
		t.Fatalf("expected second default application to be a no-op")
	}
}

func TestApplyDefaultsPreservesCustomStorageClass(t *testing.T) {
	sc := "premium"
	cluster := &v1alpha1.TigerBeetleCluster{}
	cluster.Spec.StorageClassName = &sc

	if updated := cluster.ApplyDefaults(); !updated {
		t.Fatalf("expected defaults to apply to other fields")
	}

	if cluster.Spec.StorageClassName == nil || *cluster.Spec.StorageClassName != sc {
		t.Fatalf("expected custom storage class to be preserved")
	}
}

func TestStorageClassMutationRetainsValue(t *testing.T) {
	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)
	_ = appsv1.AddToScheme(scheme)
	_ = v1alpha1.AddToScheme(scheme)

	sc := "premium"
	cluster := &v1alpha1.TigerBeetleCluster{
		ObjectMeta: metav1.ObjectMeta{Name: "tigerbeetle", Namespace: "tigerbeetle"},
		Spec: v1alpha1.TigerBeetleClusterSpec{
			ClusterID:        "0",
			Image:            "ghcr.io/tigerbeetle/tigerbeetle:0.16.60",
			Port:             3000,
			Replicas:         3,
			StorageSize:      resource.MustParse("10Gi"),
			StorageClassName: &sc,
		},
	}

	client := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&v1alpha1.TigerBeetleCluster{}).WithObjects(cluster).Build()
	reconciler := &TigerBeetleClusterReconciler{Client: client, Scheme: scheme}

	_, err := reconciler.Reconcile(context.Background(), ctrl.Request{NamespacedName: types.NamespacedName{Name: cluster.Name, Namespace: cluster.Namespace}})
	if err != nil {
		t.Fatalf("reconcile failed: %v", err)
	}

	sts := &appsv1.StatefulSet{}
	if err := client.Get(context.Background(), types.NamespacedName{Name: cluster.Name, Namespace: cluster.Namespace}, sts); err != nil {
		t.Fatalf("expected statefulset to be created: %v", err)
	}

	if sts.Spec.VolumeClaimTemplates[0].Spec.StorageClassName == nil || *sts.Spec.VolumeClaimTemplates[0].Spec.StorageClassName != sc {
		t.Fatalf("expected storage class to persist through reconciliation")
	}

	// mutate the storage class on statefulset to simulate drift
	newSC := "standard"
	sts.Spec.VolumeClaimTemplates[0].Spec.StorageClassName = ptr.To(newSC)
	if err := client.Update(context.Background(), sts); err != nil {
		t.Fatalf("failed to mutate statefulset: %v", err)
	}

	if _, err := reconciler.Reconcile(context.Background(), ctrl.Request{NamespacedName: types.NamespacedName{Name: cluster.Name, Namespace: cluster.Namespace}}); err != nil {
		t.Fatalf("reconcile failed: %v", err)
	}

	refreshed := &appsv1.StatefulSet{}
	if err := client.Get(context.Background(), types.NamespacedName{Name: cluster.Name, Namespace: cluster.Namespace}, refreshed); err != nil {
		t.Fatalf("failed to get refreshed statefulset: %v", err)
	}

	if refreshed.Spec.VolumeClaimTemplates[0].Spec.StorageClassName == nil || *refreshed.Spec.VolumeClaimTemplates[0].Spec.StorageClassName != sc {
		t.Fatalf("expected reconciliation to restore storage class from spec")
	}
}
