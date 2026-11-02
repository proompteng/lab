package workerdeployment

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	deploymentpb "go.temporal.io/api/deployment/v1"
	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/api/workflowservice/v1"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/workflow"
	deploymentspb "go.temporal.io/server/api/deployment/v1"
	matchingservice "go.temporal.io/server/api/matchingservice/v1"
	matchingmock "go.temporal.io/server/api/matchingservicemock/v1"
	persistence "go.temporal.io/server/api/persistence/v1"
	"go.temporal.io/server/common/namespace"
	"go.uber.org/mock/gomock"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

type routingVersionClient struct {
	Client
	info *deploymentpb.WorkerDeploymentVersionInfo
}

func (c routingVersionClient) DescribeVersion(_ context.Context, _ *namespace.Namespace, _ string, _ bool) (*deploymentpb.WorkerDeploymentVersionInfo, []*workflowservice.DescribeWorkerDeploymentVersionResponse_VersionTaskQueue, error) {
	return c.info, nil, nil
}

func TestRoutingReconciliationActivity(t *testing.T) {
	for _, scenario := range []string{"complete", "partial-failure", "wrong-revision", "wrong-config", "zero-version", "no-queues"} {
		t.Run(scenario, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			matching := matchingmock.NewMockMatchingServiceClient(ctrl)
			routing := &deploymentpb.RoutingConfig{CurrentVersion: "deployment.current", RevisionNumber: 100}
			queues := []*deploymentpb.WorkerDeploymentVersionInfo_VersionTaskQueueInfo{
				{Name: "queue", Type: enumspb.TASK_QUEUE_TYPE_WORKFLOW}, {Name: "queue", Type: enumspb.TASK_QUEUE_TYPE_ACTIVITY},
				{Name: "another-queue", Type: enumspb.TASK_QUEUE_TYPE_WORKFLOW},
			}
			if scenario == "no-queues" {
				queues = nil
			}
			a := &Activities{namespace: namespace.NewLocalNamespaceForTest(&persistence.NamespaceInfo{Id: "test-id", Name: "test"}, nil, "test"), activityDeps: activityDeps{
				MatchingClient: matching, WorkerDeploymentClient: routingVersionClient{info: &deploymentpb.WorkerDeploymentVersionInfo{TaskQueueInfos: queues}},
			}}
			for i, queue := range queues {
				matching.EXPECT().SyncDeploymentUserData(gomock.Any(), gomock.Any()).DoAndReturn(func(_ context.Context, req *matchingservice.SyncDeploymentUserDataRequest, _ ...any) (*matchingservice.SyncDeploymentUserDataResponse, error) {
					require.Equal(t, "test-id", req.NamespaceId)
					require.Equal(t, "deployment", req.DeploymentName)
					require.Equal(t, queue.Name, req.TaskQueue)
					require.Equal(t, []enumspb.TaskQueueType{queue.Type}, req.TaskQueueTypes)
					require.True(t, proto.Equal(routing, req.UpdateRoutingConfig))
					require.Nil(t, req.Operation)
					require.Empty(t, req.ForgetVersions)
					require.Empty(t, req.UpsertVersionsData)
					if scenario == "zero-version" {
						return &matchingservice.SyncDeploymentUserDataResponse{}, nil
					}
					return &matchingservice.SyncDeploymentUserDataResponse{Version: int64(17 + i)}, nil
				})
				if scenario == "zero-version" {
					break
				}
				check := matching.EXPECT().CheckTaskQueueUserDataPropagation(gomock.Any(), gomock.Any())
				if scenario == "partial-failure" && i == 1 {
					check.Return(nil, serviceerror.NewUnavailable("partition unavailable"))
					break
				}
				check.DoAndReturn(func(_ context.Context, req *matchingservice.CheckTaskQueueUserDataPropagationRequest, _ ...any) (*matchingservice.CheckTaskQueueUserDataPropagationResponse, error) {
					require.Equal(t, "test-id", req.NamespaceId)
					require.Equal(t, queue.Name, req.TaskQueue)
					require.Equal(t, int64(17+i), req.Version)
					return &matchingservice.CheckTaskQueueUserDataPropagationResponse{}, nil
				})
				observed := proto.Clone(routing).(*deploymentpb.RoutingConfig)
				if scenario == "wrong-revision" {
					observed.RevisionNumber = 101
				}
				if scenario == "wrong-config" {
					observed.CurrentVersion = "deployment.other"
				}
				matching.EXPECT().GetTaskQueueUserData(gomock.Any(), gomock.Any()).DoAndReturn(func(_ context.Context, req *matchingservice.GetTaskQueueUserDataRequest, _ ...any) (*matchingservice.GetTaskQueueUserDataResponse, error) {
					require.Equal(t, "test-id", req.NamespaceId)
					require.Equal(t, queue.Name, req.TaskQueue)
					require.Equal(t, enumspb.TASK_QUEUE_TYPE_WORKFLOW, req.TaskQueueType)
					return &matchingservice.GetTaskQueueUserDataResponse{
						UserData: &persistence.VersionedTaskQueueUserData{Version: int64(17 + i), Data: &persistence.TaskQueueUserData{
							PerType: map[int32]*persistence.TaskQueueTypeUserData{int32(queue.Type): {DeploymentData: &persistence.DeploymentData{DeploymentsData: map[string]*persistence.WorkerDeploymentData{
								"deployment": {RoutingConfig: observed},
							}}}},
						}},
					}, nil
				})
				if scenario == "wrong-revision" || scenario == "wrong-config" {
					break
				}
			}
			err := a.ReconcileWorkerDeploymentRouting(context.Background(), &RoutingReconciliationArgs{Version: "deployment.previous", RoutingConfig: routing})
			if scenario == "complete" {
				require.NoError(t, err)
			} else {
				require.Error(t, err)
			}
		})
	}
}

func TestRoutingReconciliationWorkflow(t *testing.T) {
	for _, scenario := range []string{"complete", "partial-failure", "missing-token", "stale-token", "managed-same-identity", "retry", "timeout", "concurrent-change", "already-reconciled"} {
		t.Run(scenario, func(t *testing.T) {
			var suite testsuite.WorkflowTestSuite
			env := suite.NewTestWorkflowEnvironment()
			env.RegisterWorkflowWithOptions(func(ctx workflow.Context, args *deploymentspb.WorkerDeploymentWorkflowArgs) error {
				return Workflow(ctx, func() DeploymentWorkflowVersion { return VersionDataRevisionNumber }, func() int { return 100 }, args)
			}, workflow.RegisterOptions{Name: WorkerDeploymentWorkflowType})
			env.OnUpsertMemo(mock.Anything).Return(nil).Maybe()
			state := &deploymentspb.WorkerDeploymentLocalState{
				CreateTime: timestamppb.New(time.Unix(100, 0)), ConflictToken: []byte("token"), LastModifierIdentity: "worker",
				RoutingConfig:        &deploymentpb.RoutingConfig{CurrentVersion: "deployment.current", RevisionNumber: 100},
				Versions:             map[string]*deploymentspb.WorkerDeploymentVersionSummary{"deployment.current": {Version: "deployment.current"}, "deployment.a": {Version: "deployment.a"}, "deployment.b": {Version: "deployment.b"}},
				PropagatingRevisions: map[string]*deploymentspb.PropagatingRevisions{"a": {RevisionNumbers: []int64{97, 98}}, "b": {RevisionNumbers: []int64{99}}},
			}
			identity := "recovery"
			if scenario == "concurrent-change" {
				state.Versions["deployment.next"] = &deploymentspb.WorkerDeploymentVersionSummary{Version: "deployment.next"}
			}
			if scenario == "already-reconciled" {
				state.PropagatingRevisions = nil
				identity = "worker"
			}
			if scenario == "managed-same-identity" {
				state.ManagerIdentity = "worker"
				identity = "worker"
			}
			token := []byte("token")
			if scenario == "missing-token" {
				token = nil
			}
			if scenario == "stale-token" {
				token = []byte("stale")
			}
			var a *Activities
			env.RegisterActivity(a.IsVersionMissingTaskQueues)
			env.RegisterActivity(a.ReconcileWorkerDeploymentRouting)
			if scenario != "stale-token" && scenario != "already-reconciled" {
				env.OnActivity(a.IsVersionMissingTaskQueues, mock.Anything, mock.Anything).Return(&deploymentspb.IsVersionMissingTaskQueuesResult{}, nil).Once()
			}
			if scenario == "complete" || scenario == "partial-failure" || scenario == "managed-same-identity" || scenario == "retry" || scenario == "timeout" || scenario == "concurrent-change" {
				for _, build := range []string{"a", "b"} {
					matcher := mock.MatchedBy(func(args *RoutingReconciliationArgs) bool {
						return args.Version == "deployment."+build && args.RoutingConfig.RevisionNumber == 100 && args.RoutingConfig.CurrentVersion == "deployment.current"
					})
					if scenario == "timeout" {
						env.OnActivity(a.ReconcileWorkerDeploymentRouting, mock.Anything, matcher).Return(temporal.NewTimeoutError(enumspb.TIMEOUT_TYPE_SCHEDULE_TO_CLOSE, nil))
						break
					}
					if scenario == "retry" && build == "a" {
						env.OnActivity(a.ReconcileWorkerDeploymentRouting, mock.Anything, matcher).Return(temporal.NewApplicationError("transient matching error", "transient")).Once()
					}
					call := env.OnActivity(a.ReconcileWorkerDeploymentRouting, mock.Anything, matcher).Once()
					if scenario == "concurrent-change" && build == "a" {
						call.After(10 * time.Millisecond)
					}
					if scenario == "partial-failure" && build == "b" {
						call.Return(temporal.NewNonRetryableApplicationError("unverified partition", "unverified", nil))
					} else {
						call.Return(nil)
					}
				}
			}
			env.SetOnActivityStartedListener(func(info *activity.Info, _ context.Context, _ converter.EncodedValues) {
				if info.ActivityType.Name == "ReconcileWorkerDeploymentRouting" {
					require.Equal(t, 2*time.Minute, info.ScheduleToCloseTimeout)
					require.Equal(t, time.Minute, info.StartToCloseTimeout)
				}
			})
			var secondErr error
			secondHandled := false
			if scenario == "concurrent-change" {
				env.RegisterDelayedCallback(func() {
					env.UpdateWorkflow(SetCurrentVersion, "concurrent", &testsuite.TestUpdateCallback{
						OnReject: func(err error) { secondHandled = true; secondErr = err }, OnAccept: func() {}, OnComplete: func(_ any, err error) { secondHandled = true; secondErr = err },
					}, &deploymentspb.SetCurrentVersionArgs{Version: "deployment.next", Identity: "another-worker", ConflictToken: token})
				}, 2*time.Millisecond)
			}
			var resultErr error
			handled := false
			env.RegisterDelayedCallback(func() {
				env.UpdateWorkflow(SetCurrentVersion, "recovery", &testsuite.TestUpdateCallback{
					OnReject: func(err error) { handled = true; resultErr = err }, OnAccept: func() {}, OnComplete: func(_ any, err error) { handled = true; resultErr = err },
				}, &deploymentspb.SetCurrentVersionArgs{Version: "deployment.current", Identity: identity, ConflictToken: token})
			}, time.Millisecond)
			env.RegisterDelayedCallback(func() { env.CancelWorkflow() }, 5*time.Minute)
			env.ExecuteWorkflow(WorkerDeploymentWorkflowType, &deploymentspb.WorkerDeploymentWorkflowArgs{NamespaceName: "test", NamespaceId: "test-id", DeploymentName: "deployment", State: state})
			require.True(t, handled)
			success := scenario == "complete" || scenario == "managed-same-identity" || scenario == "retry" || scenario == "concurrent-change"
			if success {
				require.NoError(t, resultErr)
			} else {
				require.Error(t, resultErr)
			}
			var continued deploymentspb.WorkerDeploymentWorkflowArgs
			var can *workflow.ContinueAsNewError
			if errors.As(env.GetWorkflowError(), &can) {
				require.NoError(t, converter.GetDefaultDataConverter().FromPayloads(can.Input, &continued))
				state = continued.State
			}
			require.Equal(t, "deployment.current", state.RoutingConfig.CurrentVersion)
			require.Equal(t, int64(100), state.RoutingConfig.RevisionNumber)
			if scenario == "concurrent-change" {
				require.Len(t, state.Versions, 4)
				require.True(t, secondHandled)
				require.ErrorContains(t, secondErr, "conflict token mismatch")
			} else {
				require.Len(t, state.Versions, 3)
			}
			if success || scenario == "already-reconciled" {
				require.Empty(t, state.PropagatingRevisions)
			} else if scenario == "partial-failure" {
				require.NotContains(t, state.PropagatingRevisions, "a")
				require.Equal(t, []int64{99}, state.PropagatingRevisions["b"].RevisionNumbers)
			} else {
				require.Len(t, state.PropagatingRevisions, 2)
			}
			env.AssertExpectations(t)
		})
	}
}
