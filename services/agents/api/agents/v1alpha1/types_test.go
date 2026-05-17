package v1alpha1

import (
	"testing"
	"time"

	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

func TestGroupVersionValues(t *testing.T) {
	if GroupVersion.Group != "agents.proompteng.ai" {
		t.Fatalf("unexpected group: %q", GroupVersion.Group)
	}
	if GroupVersion.Version != "v1alpha1" {
		t.Fatalf("unexpected version: %q", GroupVersion.Version)
	}
}

func TestAddToSchemeRegistersKnownTypes(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := AddToScheme(scheme); err != nil {
		t.Fatalf("AddToScheme returned error: %v", err)
	}
	if err := AddToScheme(scheme); err != nil {
		t.Fatalf("AddToScheme should be idempotent, got error: %v", err)
	}

	kinds := []string{
		"Agent",
		"AgentList",
		"AgentRun",
		"AgentRunList",
		"AgentProvider",
		"AgentProviderList",
		"ImplementationSpec",
		"ImplementationSpecList",
		"ImplementationSource",
		"ImplementationSourceList",
		"Memory",
		"MemoryList",
	}
	for _, kind := range kinds {
		gvk := GroupVersion.WithKind(kind)
		if !scheme.Recognizes(gvk) {
			t.Fatalf("scheme does not recognize %s", gvk.String())
		}
	}
}

func TestWorkflowStepDeepCopyIncludesLoop(t *testing.T) {
	step := &WorkflowStep{
		Name: "implement",
		Loop: &WorkflowLoopSpec{
			MaxIterations: 3,
			Condition: &WorkflowLoopConditionSpec{
				Type:       "cel",
				Expression: "control.continue == true",
				Source: &WorkflowLoopConditionSourceSpec{
					Type:      "file",
					Path:      "/workspace/loop-control.json",
					OnMissing: "stop",
					OnInvalid: "fail",
				},
			},
			State: &WorkflowLoopStateSpec{
				Required:    true,
				VolumeNames: []string{"workspace"},
			},
		},
	}

	cloned := step.DeepCopy()
	if cloned == nil {
		t.Fatalf("expected deep copy to be non-nil")
	}
	if cloned.Loop == nil {
		t.Fatalf("expected loop to be copied")
	}
	if cloned.Loop == step.Loop {
		t.Fatalf("expected loop pointer to be deep-copied")
	}
	if cloned.Loop.Condition == nil || cloned.Loop.Condition.Source == nil {
		t.Fatalf("expected loop condition and source to be copied")
	}
	if cloned.Loop.State == nil {
		t.Fatalf("expected loop state to be copied")
	}

	cloned.Loop.MaxIterations = 8
	cloned.Loop.Condition.Source.Path = "/workspace/other-control.json"
	cloned.Loop.State.VolumeNames[0] = "other"

	if step.Loop.MaxIterations != 3 {
		t.Fatalf("expected source maxIterations to remain 3, got %d", step.Loop.MaxIterations)
	}
	if step.Loop.Condition.Source.Path != "/workspace/loop-control.json" {
		t.Fatalf("expected source path to remain unchanged, got %q", step.Loop.Condition.Source.Path)
	}
	if step.Loop.State.VolumeNames[0] != "workspace" {
		t.Fatalf("expected source volumeNames to remain unchanged, got %q", step.Loop.State.VolumeNames[0])
	}
}

func TestWorkflowStepStatusDeepCopyIncludesLoopStatus(t *testing.T) {
	started := metav1.NewTime(time.Unix(1_700_000_000, 0).UTC())
	finished := metav1.NewTime(started.Add(2 * time.Minute))

	status := &WorkflowStepStatus{
		Name:  "implement",
		Phase: "Running",
		Loop: &WorkflowLoopStatus{
			CurrentIteration:    2,
			CompletedIterations: 1,
			MaxIterations:       5,
			StopReason:          "",
			LastControl: map[string]apiextensionsv1.JSON{
				"continue": {Raw: []byte("true")},
			},
			Iterations: []WorkflowLoopIterationStatus{
				{
					Index:      1,
					Phase:      "Succeeded",
					Attempts:   1,
					StartedAt:  &started,
					FinishedAt: &finished,
					Message:    "done",
					JobRef: &JobRef{
						Name:      "agentrun-step-iter-1",
						Namespace: "agents",
						Uid:       "abc123",
					},
				},
			},
		},
	}

	cloned := status.DeepCopy()
	if cloned == nil {
		t.Fatalf("expected deep copy to be non-nil")
	}
	if cloned.Loop == nil {
		t.Fatalf("expected loop status to be copied")
	}
	if cloned.Loop == status.Loop {
		t.Fatalf("expected loop status pointer to be deep-copied")
	}
	if cloned.Loop.Iterations[0].JobRef == status.Loop.Iterations[0].JobRef {
		t.Fatalf("expected nested jobRef pointer to be deep-copied")
	}
	if cloned.Loop.Iterations[0].StartedAt == status.Loop.Iterations[0].StartedAt {
		t.Fatalf("expected nested startedAt pointer to be deep-copied")
	}

	cloned.Loop.CurrentIteration = 9
	cloned.Loop.LastControl["continue"] = apiextensionsv1.JSON{Raw: []byte("false")}
	cloned.Loop.Iterations[0].Phase = "Failed"
	cloned.Loop.Iterations[0].JobRef.Name = "changed"
	cloned.Loop.Iterations[0].StartedAt.Time = cloned.Loop.Iterations[0].StartedAt.Time.Add(10 * time.Minute)

	if status.Loop.CurrentIteration != 2 {
		t.Fatalf("expected source currentIteration to remain 2, got %d", status.Loop.CurrentIteration)
	}
	if string(status.Loop.LastControl["continue"].Raw) != "true" {
		t.Fatalf("expected source lastControl to remain true, got %q", string(status.Loop.LastControl["continue"].Raw))
	}
	if status.Loop.Iterations[0].Phase != "Succeeded" {
		t.Fatalf("expected source iteration phase to remain Succeeded, got %q", status.Loop.Iterations[0].Phase)
	}
	if status.Loop.Iterations[0].JobRef.Name != "agentrun-step-iter-1" {
		t.Fatalf("expected source jobRef name to remain unchanged, got %q", status.Loop.Iterations[0].JobRef.Name)
	}
	expectedStarted := time.Unix(1_700_000_000, 0).UTC()
	if !status.Loop.Iterations[0].StartedAt.Time.Equal(expectedStarted) {
		t.Fatalf("expected source startedAt to remain unchanged, got %s", status.Loop.Iterations[0].StartedAt.Time)
	}
}
