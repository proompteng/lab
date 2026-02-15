package builder

import (
	"testing"

	"github.com/google/go-cmp/cmp"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"

	v1alpha1 "github.com/proompteng/lab/services/tigresse/api/v1alpha1"
)

func testCluster() *v1alpha1.TigerBeetleCluster {
	cluster := &v1alpha1.TigerBeetleCluster{}
	cluster.Name = "tigerbeetle"
	cluster.Namespace = "tigerbeetle"
	sc := "rook-ceph-block"
	cluster.Spec = v1alpha1.TigerBeetleClusterSpec{
		ClusterID:        "0",
		Image:            "ghcr.io/tigerbeetle/tigerbeetle:0.16.60",
		Port:             3000,
		Replicas:         3,
		StorageSize:      resource.MustParse("10Gi"),
		StorageClassName: &sc,
	}
	return cluster
}

func TestBuildConfigMap(t *testing.T) {
	cm := BuildConfigMap(testCluster())
	if cm.Data["start.sh"] == "" {
		t.Fatalf("expected start script to be populated")
	}
}

func TestBuildService(t *testing.T) {
	cluster := testCluster()
	svc := BuildService(cluster)
	if svc.Spec.Ports[0].Port != 3000 {
		t.Fatalf("expected service port 3000, got %d", svc.Spec.Ports[0].Port)
	}
	if diff := cmp.Diff(Labels(cluster), svc.Spec.Selector); diff != "" {
		t.Fatalf("unexpected selector diff: %s", diff)
	}
}

func TestBuildHeadlessService(t *testing.T) {
	cluster := testCluster()
	svc := BuildHeadlessService(cluster)
	if svc.Spec.ClusterIP != "None" {
		t.Fatalf("expected headless service")
	}
}

func TestBuildStatefulSet(t *testing.T) {
	cluster := testCluster()
	sts := BuildStatefulSet(cluster)

	if sts.Spec.Template.Spec.Containers[0].Image != cluster.Spec.Image {
		t.Fatalf("expected container image propagated")
	}

	if sts.Spec.VolumeClaimTemplates[0].Spec.Resources.Requests[corev1.ResourceStorage] != cluster.Spec.StorageSize {
		t.Fatalf("expected storage request to equal spec size")
	}

	if sts.Spec.Template.Spec.Containers[0].Env[3].Name != "REPLICA_COUNT" {
		t.Fatalf("expected env var for replica count")
	}

	if len(sts.Spec.Template.Spec.InitContainers) == 0 {
		t.Fatalf("expected init container present")
	}

	if sts.Spec.Template.Spec.Containers[0].Ports[0].ContainerPort != int32(3000) {
		t.Fatalf("expected container port 3000")
	}
}

func TestStorageClassPropagation(t *testing.T) {
	cluster := testCluster()
	sc := "fast"
	cluster.Spec.StorageClassName = &sc

	sts := BuildStatefulSet(cluster)
	if sts.Spec.VolumeClaimTemplates[0].Spec.StorageClassName == nil || *sts.Spec.VolumeClaimTemplates[0].Spec.StorageClassName != sc {
		t.Fatalf("expected storage class to propagate")
	}
}

func TestBuildStatefulSetAppliesDefaultStorageClass(t *testing.T) {
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

	if updated := cluster.ApplyDefaults(); !updated {
		t.Fatalf("expected defaults to be applied")
	}

	sts := BuildStatefulSet(cluster)
	if sts.Spec.VolumeClaimTemplates[0].Spec.StorageClassName == nil {
		t.Fatalf("expected storage class to be set by defaults")
	}
	if sc := *sts.Spec.VolumeClaimTemplates[0].Spec.StorageClassName; sc != "rook-ceph-block" {
		t.Fatalf("expected default storage class rook-ceph-block, got %s", sc)
	}
}

func TestLabels(t *testing.T) {
	cluster := testCluster()
	labels := Labels(cluster)
	if labels[labelAppName] != "tigerbeetle" {
		t.Fatalf("expected app label to match cluster name")
	}
}

func TestConfigMapName(t *testing.T) {
	if ConfigMapName(testCluster()) != "tigerbeetle-start-script" {
		t.Fatalf("unexpected configmap name")
	}
}

func TestHeadlessServiceName(t *testing.T) {
	if HeadlessServiceName(testCluster()) != "tigerbeetle-headless" {
		t.Fatalf("unexpected headless service name")
	}
}

func TestStatefulSetHasOwnerLabels(t *testing.T) {
	cluster := testCluster()
	sts := BuildStatefulSet(cluster)
	if diff := cmp.Diff(Labels(cluster), sts.Spec.Template.Labels); diff != "" {
		t.Fatalf("unexpected template label diff: %s", diff)
	}
}

func TestStatefulSetDefaults(t *testing.T) {
	cluster := testCluster()
	cluster.Spec.Replicas = 1
	sts := BuildStatefulSet(cluster)
	if sts.Spec.Replicas == nil || *sts.Spec.Replicas != 1 {
		t.Fatalf("expected replica override to carry through")
	}

	if sts.Spec.PodManagementPolicy != appsv1.ParallelPodManagement {
		t.Fatalf("expected parallel pod management")
	}
}
