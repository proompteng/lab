package workerdeployment

import (
	"context"
	"errors"
	"time"

	"github.com/stretchr/testify/mock"
	deploymentpb "go.temporal.io/api/deployment/v1"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/workflow"
	deploymentspb "go.temporal.io/server/api/deployment/v1"
)

func (s *WorkerDeploymentSuite) Test_RoutingSignalAtActivityCompletion() {
	s.checkRoutingSignalDrain(1, false)
}
func (s *WorkerDeploymentSuite) Test_RoutingMultipleSignalsAtActivityCompletion() {
	s.checkRoutingSignalDrain(3, false)
}
func (s *WorkerDeploymentSuite) Test_RoutingNoSignalAtActivityCompletion() {
	s.checkRoutingSignalDrain(0, false)
}
func (s *WorkerDeploymentSuite) Test_RoutingLegacySignalAtActivityCompletion() {
	s.checkRoutingSignalDrain(1, true)
}

func (s *WorkerDeploymentSuite) checkRoutingSignalDrain(count int, legacy bool) {
	s.env.OnUpsertMemo(mock.Anything).Return(nil)
	var a *Activities
	s.env.RegisterActivity(a.IsVersionMissingTaskQueues)
	s.env.OnActivity(a.IsVersionMissingTaskQueues, mock.Anything, mock.Anything).Return((*deploymentspb.IsVersionMissingTaskQueuesResult)(nil), activity.ErrResultPending).Once()
	const version = "deployment.current"
	const build = "previous"
	revisions := []int64{98}
	for i := 1; i < count; i++ {
		revisions = append(revisions, 98+int64(i))
	}
	if legacy {
		s.env.OnGetVersion("drain-deployment-signals-before-can", workflow.DefaultVersion, 0).Return(workflow.DefaultVersion)
	}
	s.env.OnGetVersion("reconcile-pending-routing", workflow.DefaultVersion, 0).Return(workflow.DefaultVersion).Maybe()
	s.env.SetOnActivityStartedListener(func(info *activity.Info, _ context.Context, _ converter.EncodedValues) {
		s.env.RegisterDelayedCallback(func() {
			for i := 0; i < count; i++ {
				s.env.SignalWorkflowSkippingWorkflowTask(PropagationCompleteSignal, &deploymentspb.PropagationCompletionInfo{BuildId: build, RevisionNumber: 98 + int64(i)})
			}
			s.Require().NoError(s.env.CompleteActivity(info.TaskToken, &deploymentspb.IsVersionMissingTaskQueuesResult{}, nil))
		}, time.Millisecond)
	})
	s.env.RegisterDelayedCallback(func() {
		s.env.UpdateWorkflow(SetCurrentVersion, "retry-current", &testsuite.TestUpdateCallback{
			OnReject: func(err error) { s.Require().NoError(err) }, OnAccept: func() {},
			OnComplete: func(_ any, err error) { s.Require().NoError(err) },
		}, &deploymentspb.SetCurrentVersionArgs{Version: version, Identity: "current-worker"})
	}, time.Millisecond)
	s.env.ExecuteWorkflow(WorkerDeploymentWorkflowType, &deploymentspb.WorkerDeploymentWorkflowArgs{
		NamespaceName: "test", NamespaceId: "test-id", DeploymentName: "deployment",
		State: &deploymentspb.WorkerDeploymentLocalState{
			Versions:             map[string]*deploymentspb.WorkerDeploymentVersionSummary{version: {Version: version}},
			RoutingConfig:        &deploymentpb.RoutingConfig{CurrentVersion: version, RevisionNumber: 100},
			PropagatingRevisions: map[string]*deploymentspb.PropagatingRevisions{build: {RevisionNumbers: revisions}},
		},
	})
	s.Require().True(s.env.IsWorkflowCompleted())
	var can *workflow.ContinueAsNewError
	s.Require().True(errors.As(s.env.GetWorkflowError(), &can))
	var continued deploymentspb.WorkerDeploymentWorkflowArgs
	s.Require().NoError(converter.GetDefaultDataConverter().FromPayloads(can.Input, &continued))
	if legacy || count == 0 {
		s.Equal(revisions, continued.State.PropagatingRevisions[build].RevisionNumbers)
	} else {
		s.Empty(continued.State.PropagatingRevisions, "delivered propagation completion must be handled before continue-as-new")
	}
}
