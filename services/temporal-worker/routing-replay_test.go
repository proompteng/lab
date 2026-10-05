package workerdeployment

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	deploymentpb "go.temporal.io/api/deployment/v1"
	enumspb "go.temporal.io/api/enums/v1"
	historypb "go.temporal.io/api/history/v1"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
	deploymentspb "go.temporal.io/server/api/deployment/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func routingReplayWorkflow(ctx workflow.Context, args *deploymentspb.WorkerDeploymentWorkflowArgs) error {
	return Workflow(ctx, func() DeploymentWorkflowVersion { return VersionDataRevisionNumber }, func() int { return 100 }, args)
}

func TestRoutingReconciliationReplays(t *testing.T) {
	files, err := filepath.Glob("testdata/routing-reconciliation/*.json")
	require.NoError(t, err)
	require.Len(t, files, 3)
	for _, path := range files {
		t.Run(filepath.Base(path), func(t *testing.T) {
			replayer := worker.NewWorkflowReplayer()
			data, err := os.ReadFile(path)
			require.NoError(t, err)
			history := &historypb.History{}
			require.NoError(t, protojson.Unmarshal(data, history))
			var observed deploymentspb.WorkerDeploymentWorkflowArgs
			replayer.RegisterWorkflowWithOptions(func(ctx workflow.Context, args *deploymentspb.WorkerDeploymentWorkflowArgs) error {
				err := routingReplayWorkflow(ctx, args)
				var can *workflow.ContinueAsNewError
				if errors.As(err, &can) {
					if decodeErr := converter.GetDefaultDataConverter().FromPayloads(can.Input, &observed); decodeErr != nil {
						panic(decodeErr)
					}
				}
				return err
			}, workflow.RegisterOptions{Name: WorkerDeploymentWorkflowType})
			require.NoError(t, replayer.ReplayWorkflowHistory(nil, history))
			var recorded deploymentspb.WorkerDeploymentWorkflowArgs
			require.NoError(t, converter.GetDefaultDataConverter().FromPayloads(history.Events[len(history.Events)-1].GetWorkflowExecutionContinuedAsNewEventAttributes().GetInput(), &recorded))
			require.True(t, proto.Equal(recorded.State, observed.State), "replay must preserve the recorded continued state")
			require.Equal(t, int64(100), observed.State.RoutingConfig.RevisionNumber)
			require.Equal(t, "deployment.current", observed.State.RoutingConfig.CurrentVersion)
			if filepath.Base(path) == "partial.json" {
				require.Equal(t, []int64{99}, observed.State.PropagatingRevisions["b"].RevisionNumbers)
				require.Len(t, observed.State.PropagatingRevisions, 1)
			} else {
				require.Empty(t, observed.State.PropagatingRevisions)
			}
		})
	}
}

func TestCaptureRoutingReconciliationReplays(t *testing.T) {
	address := os.Getenv("TEMPORAL_ROUTING_REPLAY_CAPTURE_ADDRESS")
	if address == "" {
		t.Skip("capture is opt-in against an isolated loopback dev server")
	}
	require.Equal(t, "127.0.0.1:17233", address)
	c, err := client.Dial(client.Options{HostPort: address, Namespace: "default", Identity: "routing-replay-proof"})
	require.NoError(t, err)
	defer c.Close()
	w := worker.New(c, "routing-replay-proof", worker.Options{Identity: "routing-replay-proof", MaxConcurrentWorkflowTaskPollers: 2, MaxConcurrentActivityTaskPollers: 1})
	w.RegisterWorkflowWithOptions(routingReplayWorkflow, workflow.RegisterOptions{Name: WorkerDeploymentWorkflowType})
	w.RegisterActivityWithOptions(func(context.Context, *deploymentspb.IsVersionMissingTaskQueuesArgs) (*deploymentspb.IsVersionMissingTaskQueuesResult, error) {
		return &deploymentspb.IsVersionMissingTaskQueuesResult{}, nil
	}, activity.RegisterOptions{Name: "IsVersionMissingTaskQueues"})
	var failedB atomic.Bool
	var repairs atomic.Int32
	w.RegisterActivityWithOptions(func(ctx context.Context, args *RoutingReconciliationArgs) error {
		repairs.Add(1)
		if strings.Contains(activity.GetInfo(ctx).WorkflowExecution.ID, "partial") && args.Version == "deployment.b" && !failedB.Swap(true) {
			return temporal.NewNonRetryableApplicationError("fixture partition unavailable", "fixture-partial-failure", nil)
		}
		return nil
	}, activity.RegisterOptions{Name: "ReconcileWorkerDeploymentRouting"})
	require.NoError(t, w.Start())
	defer w.Stop()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	require.NoError(t, os.MkdirAll("testdata/routing-reconciliation", 0755))
	for _, scenario := range []string{"success", "partial"} {
		id := "routing-replay-proof-" + scenario
		run, err := c.ExecuteWorkflow(ctx, client.StartWorkflowOptions{ID: id, TaskQueue: "routing-replay-proof", WorkflowExecutionTimeout: time.Minute}, WorkerDeploymentWorkflowType, &deploymentspb.WorkerDeploymentWorkflowArgs{
			NamespaceName: "default", NamespaceId: "routing-replay-proof", DeploymentName: "deployment", State: &deploymentspb.WorkerDeploymentLocalState{
				CreateTime: timestamppb.New(time.Unix(100, 0)), ConflictToken: []byte("fixture-token"), LastModifierIdentity: "worker",
				RoutingConfig:        &deploymentpb.RoutingConfig{CurrentVersion: "deployment.current", RevisionNumber: 100},
				Versions:             map[string]*deploymentspb.WorkerDeploymentVersionSummary{"deployment.current": {Version: "deployment.current"}, "deployment.a": {Version: "deployment.a"}, "deployment.b": {Version: "deployment.b"}},
				PropagatingRevisions: map[string]*deploymentspb.PropagatingRevisions{"a": {RevisionNumbers: []int64{98}}, "b": {RevisionNumbers: []int64{99}}},
			},
		})
		require.NoError(t, err)
		currentRun := run.GetRunID()
		token := []byte("fixture-token")
		for attempt := 0; attempt < 2; attempt++ {
			update, err := c.UpdateWorkflow(ctx, client.UpdateWorkflowOptions{WorkflowID: id, RunID: currentRun, UpdateName: SetCurrentVersion, Args: []any{&deploymentspb.SetCurrentVersionArgs{Version: "deployment.current", Identity: "recovery", ConflictToken: token}}, WaitForStage: client.WorkflowUpdateStageCompleted})
			require.NoError(t, err)
			var result deploymentspb.SetCurrentVersionResponse
			err = update.Get(ctx, &result)
			if scenario == "partial" && attempt == 0 {
				require.ErrorContains(t, err, "fixture partition unavailable")
			} else {
				require.NoError(t, err)
				token = result.ConflictToken
			}
			require.Eventually(t, func() bool {
				d, e := c.DescribeWorkflowExecution(ctx, id, currentRun)
				return e == nil && d.WorkflowExecutionInfo.Status == enumspb.WORKFLOW_EXECUTION_STATUS_CONTINUED_AS_NEW
			}, 10*time.Second, 10*time.Millisecond)
			history := &historypb.History{}
			iterator := c.GetWorkflowHistory(ctx, id, currentRun, false, enumspb.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT)
			for iterator.HasNext() {
				event, e := iterator.Next()
				require.NoError(t, e)
				history.Events = append(history.Events, event)
			}
			name := scenario
			if attempt == 1 {
				name = "retry"
			}
			bytes, e := protojson.MarshalOptions{Indent: "  "}.Marshal(history)
			require.NoError(t, e)
			require.NoError(t, os.WriteFile(filepath.Join("testdata/routing-reconciliation", name+".json"), bytes, 0644))
			d, e := c.DescribeWorkflowExecution(ctx, id, "")
			require.NoError(t, e)
			currentRun = d.WorkflowExecutionInfo.Execution.RunId
			if scenario == "success" || attempt == 1 {
				break
			}
		}
		before := repairs.Load()
		update, err := c.UpdateWorkflow(ctx, client.UpdateWorkflowOptions{WorkflowID: id, RunID: currentRun, UpdateName: SetCurrentVersion, Args: []any{&deploymentspb.SetCurrentVersionArgs{Version: "deployment.current", Identity: "recovery", ConflictToken: token}}, WaitForStage: client.WorkflowUpdateStageCompleted})
		if err == nil {
			err = update.Get(ctx, nil)
		}
		require.ErrorContains(t, err, "no change")
		require.Equal(t, before, repairs.Load(), "idempotent retry must not re-run repair activities")
	}
}
