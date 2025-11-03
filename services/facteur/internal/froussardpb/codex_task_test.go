package froussardpb

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func TestCodexTaskAccessors(t *testing.T) {
	url := "https://example.test"
	author := "reviewer"
	conclusion := "failure"
	details := "details"
	summary := "summary"
	planBody := "plan body"

	planID := int64(101)
	planURL := "https://example.test/comment"

	task := &CodexTask{
		Stage:           CodexTaskStage_CODEX_TASK_STAGE_PLANNING,
		Prompt:          "Plan work",
		Repository:      "proompteng/lab",
		Base:            "main",
		Head:            "feature",
		IssueNumber:     42,
		IssueUrl:        "https://github.com/proompteng/lab/issues/42",
		IssueTitle:      "test issue",
		IssueBody:       "body",
		Sender:          "sender",
		IssuedAt:        timestamppb.New(time.Unix(1700000000, 0)),
		PlanCommentId:   &planID,
		PlanCommentUrl:  &planURL,
		PlanCommentBody: &planBody,
		DeliveryId:      "delivery",
		ReviewContext: &CodexReviewContext{
			Summary: &summary,
			ReviewThreads: []*CodexReviewThread{
				{Summary: "thread", Url: &url, Author: &author},
			},
			FailingChecks: []*CodexFailingCheck{
				{Name: "ci", Conclusion: &conclusion, Url: &url, Details: &details},
			},
			AdditionalNotes: []string{"note"},
		},
	}

	require.Equal(t, CodexTaskStage_CODEX_TASK_STAGE_PLANNING, task.GetStage())
	require.Equal(t, "Plan work", task.GetPrompt())
	require.Equal(t, "proompteng/lab", task.GetRepository())
	require.Equal(t, "main", task.GetBase())
	require.Equal(t, "feature", task.GetHead())
	require.Equal(t, int64(42), task.GetIssueNumber())
	require.Equal(t, "https://github.com/proompteng/lab/issues/42", task.GetIssueUrl())
	require.Equal(t, "test issue", task.GetIssueTitle())
	require.Equal(t, "body", task.GetIssueBody())
	require.Equal(t, "sender", task.GetSender())
	require.NotNil(t, task.GetIssuedAt())
	require.Equal(t, int64(101), task.GetPlanCommentId())
	require.Equal(t, planURL, task.GetPlanCommentUrl())
	require.Equal(t, planBody, task.GetPlanCommentBody())
	require.Equal(t, "delivery", task.GetDeliveryId())
	require.NotNil(t, task.GetReviewContext())
	require.Equal(t, summary, task.GetReviewContext().GetSummary())
	require.NotEmpty(t, task.GetReviewContext().GetReviewThreads())
	require.NotEmpty(t, task.GetReviewContext().GetFailingChecks())
	require.NotEmpty(t, task.GetReviewContext().GetAdditionalNotes())

	task.Reset()
	require.Equal(t, int64(0), task.GetIssueNumber())
	invokeProtoGetters(t, task)
	invokeProtoGetters(t, task.GetReviewContext())
	for _, thread := range task.GetReviewContext().GetReviewThreads() {
		invokeProtoGetters(t, thread)
	}
	for _, check := range task.GetReviewContext().GetFailingChecks() {
		invokeProtoGetters(t, check)
	}

	stage := CodexTaskStage_CODEX_TASK_STAGE_REVIEW
	require.Equal(t, stage, *stage.Enum())
	require.NotNil(t, stage.Descriptor())
	require.NotNil(t, stage.Type())
	require.Equal(t, protoreflect.EnumNumber(stage), stage.Number())
	descBytes, indexes := stage.EnumDescriptor()
	require.NotNil(t, descBytes)
	require.NotEmpty(t, indexes)
}

func invokeProtoGetters(t *testing.T, msg any) {
	t.Helper()
	if msg == nil {
		return
	}
	val := reflect.ValueOf(msg)
	typ := val.Type()
	for i := 0; i < typ.NumMethod(); i++ {
		method := typ.Method(i)
		if !strings.HasPrefix(method.Name, "Get") && method.Name != "ProtoReflect" && method.Name != "String" && method.Name != "Descriptor" {
			continue
		}
		if method.Type.NumIn() != 1 {
			continue
		}
		_ = method.Func.Call([]reflect.Value{val})
	}
}
