package workerdeployment

import (
	"bytes"
	"context"
	"fmt"
	"slices"
	"time"

	deploymentpb "go.temporal.io/api/deployment/v1"
	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/workflow"
	deploymentspb "go.temporal.io/server/api/deployment/v1"
	"go.temporal.io/server/api/matchingservice/v1"
	"go.temporal.io/server/common/worker_versioning"
	"google.golang.org/protobuf/proto"
)

type RoutingReconciliationArgs struct {
	Version       string
	RoutingConfig *deploymentpb.RoutingConfig
}

func (d *WorkflowRunner) reconcilePendingRouting(ctx workflow.Context, args *deploymentspb.SetCurrentVersionArgs) error {
	if len(args.ConflictToken) == 0 || !bytes.Equal(args.ConflictToken, d.State.ConflictToken) {
		return serviceerror.NewFailedPrecondition("routing reconciliation requires the current conflict token")
	}
	if args.AllowNoPollers || args.IgnoreMissingTaskQueues {
		return serviceerror.NewFailedPrecondition("routing reconciliation requires standard task-queue safety checks")
	}
	routing := proto.Clone(d.State.RoutingConfig).(*deploymentpb.RoutingConfig)
	revision := routing.GetRevisionNumber()
	if revision <= 0 || routing.GetCurrentVersion() != args.Version {
		return serviceerror.NewFailedPrecondition("routing reconciliation requires the exact current version and a positive routing revision")
	}
	token := slices.Clone(d.State.ConflictToken)
	for _, build := range workflow.DeterministicKeys(d.State.PropagatingRevisions) {
		pending := slices.Clone(d.State.PropagatingRevisions[build].GetRevisionNumbers())
		if len(pending) == 0 {
			continue
		}
		for _, value := range pending {
			if value <= 0 || value > revision {
				return serviceerror.NewFailedPrecondition("pending routing revision is outside the current routing fence")
			}
		}
		version := worker_versioning.WorkerDeploymentVersionToStringV31(&deploymentspb.WorkerDeploymentVersion{DeploymentName: d.DeploymentName, BuildId: build})
		if _, exists := d.State.Versions[version]; !exists {
			return serviceerror.NewFailedPrecondition("pending routing version is missing from the deployment")
		}
		options := defaultActivityOptions
		options.ScheduleToCloseTimeout = 2 * time.Minute
		if err := workflow.ExecuteActivity(workflow.WithActivityOptions(ctx, options), d.a.ReconcileWorkerDeploymentRouting,
			&RoutingReconciliationArgs{Version: version, RoutingConfig: routing}).Get(ctx, nil); err != nil {
			return err
		}
		if !bytes.Equal(token, d.State.ConflictToken) || !proto.Equal(routing, d.State.RoutingConfig) {
			return serviceerror.NewFailedPrecondition("routing changed during reconciliation")
		}
		for _, value := range pending {
			if slices.Contains(d.State.PropagatingRevisions[build].GetRevisionNumbers(), value) {
				d.handlePropagationComplete(&deploymentspb.PropagationCompletionInfo{BuildId: build, RevisionNumber: value})
			}
		}
	}
	return nil
}

func (a *Activities) ReconcileWorkerDeploymentRouting(ctx context.Context, args *RoutingReconciliationArgs) error {
	version, err := worker_versioning.WorkerDeploymentVersionFromStringV31(args.Version)
	if err != nil {
		return err
	}
	if args.RoutingConfig == nil || args.RoutingConfig.GetRevisionNumber() <= 0 {
		return serviceerror.NewInvalidArgument("a positive routing revision is required")
	}
	info, _, err := a.WorkerDeploymentClient.DescribeVersion(ctx, a.namespace, args.Version, false)
	if err != nil {
		return err
	}
	if len(info.GetTaskQueueInfos()) == 0 {
		return serviceerror.NewFailedPrecondition("cannot prove routing without retained task queues")
	}
	for _, queue := range info.GetTaskQueueInfos() {
		if queue.GetName() == "" || queue.GetType() == enumspb.TASK_QUEUE_TYPE_UNSPECIFIED {
			return serviceerror.NewFailedPrecondition("retained task queue identity is incomplete")
		}
		syncResult, err := a.MatchingClient.SyncDeploymentUserData(ctx, &matchingservice.SyncDeploymentUserDataRequest{
			NamespaceId: a.namespace.ID().String(), DeploymentName: version.GetDeploymentName(),
			TaskQueue: queue.GetName(), TaskQueueTypes: []enumspb.TaskQueueType{queue.GetType()}, UpdateRoutingConfig: args.RoutingConfig,
		})
		if err != nil {
			return err
		}
		if syncResult.GetVersion() <= 0 {
			return serviceerror.NewFailedPrecondition("routing sync returned no propagation version")
		}
		if _, err := a.MatchingClient.CheckTaskQueueUserDataPropagation(ctx, &matchingservice.CheckTaskQueueUserDataPropagationRequest{
			NamespaceId: a.namespace.ID().String(), TaskQueue: queue.GetName(), Version: syncResult.GetVersion(),
		}); err != nil {
			return err
		}
		readback, err := a.MatchingClient.GetTaskQueueUserData(ctx, &matchingservice.GetTaskQueueUserDataRequest{
			NamespaceId: a.namespace.ID().String(), TaskQueue: queue.GetName(), TaskQueueType: enumspb.TASK_QUEUE_TYPE_WORKFLOW,
		})
		if err != nil {
			return err
		}
		observed := readback.GetUserData().GetData().GetPerType()[int32(queue.GetType())].GetDeploymentData().GetDeploymentsData()[version.GetDeploymentName()].GetRoutingConfig()
		if readback.GetUserData().GetVersion() < syncResult.GetVersion() || !proto.Equal(observed, args.RoutingConfig) {
			return serviceerror.NewFailedPrecondition(fmt.Sprintf("routing readback does not match revision %d for task queue %s type %s", args.RoutingConfig.GetRevisionNumber(), queue.GetName(), queue.GetType()))
		}
	}
	return nil
}
