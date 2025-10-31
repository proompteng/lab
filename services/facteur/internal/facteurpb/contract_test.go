package facteurpb

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestCommandEventAccessors(t *testing.T) {
	event := &CommandEvent{
		Provider:      "discord",
		InteractionId: "interaction",
		ApplicationId: "application",
		Command:       "dispatch",
		CommandId:     "command-id",
		Version:       1,
		Token:         "token",
		Options:       map[string]string{"env": "staging"},
		GuildId:       "guild",
		ChannelId:     "channel",
		User: &DiscordUser{
			Id:       "user",
			Username: "tester",
		},
		Member: &DiscordMember{
			Id:    "member",
			Roles: []string{"role"},
		},
		Locale:        "en-US",
		GuildLocale:   "en-US",
		Response:      &Response{Type: 4},
		Timestamp:     time.Unix(1700000000, 0).UTC().Format(time.RFC3339),
		CorrelationId: "corr",
		TraceId:       "trace",
	}

	require.Equal(t, "discord", event.GetProvider())
	require.Equal(t, "interaction", event.GetInteractionId())
	require.Equal(t, "application", event.GetApplicationId())
	require.Equal(t, "dispatch", event.GetCommand())
	require.Equal(t, "command-id", event.GetCommandId())
	require.Equal(t, uint32(1), event.GetVersion())
	require.Equal(t, "token", event.GetToken())
	require.Equal(t, "staging", event.GetOptions()["env"])
	require.Equal(t, "guild", event.GetGuildId())
	require.Equal(t, "channel", event.GetChannelId())
	require.NotNil(t, event.GetUser())
	require.NotNil(t, event.GetMember())
	require.Equal(t, "user", event.GetUser().GetId())
	require.Equal(t, "tester", event.GetUser().GetUsername())
	require.Equal(t, "", event.GetUser().GetGlobalName())
	require.Equal(t, "", event.GetUser().GetDiscriminator())
	require.Equal(t, "member", event.GetMember().GetId())
	require.Equal(t, []string{"role"}, event.GetMember().GetRoles())
	require.Equal(t, "en-US", event.GetLocale())
	require.Equal(t, "en-US", event.GetGuildLocale())
	require.NotNil(t, event.GetResponse())
	flagValue := uint32(1)
	event.Response.Flags = &flagValue
	require.Equal(t, uint32(4), event.GetResponse().GetType())
	require.Equal(t, uint32(1), event.GetResponse().GetFlags())
	require.NotEmpty(t, event.GetTimestamp())
	require.Equal(t, "corr", event.GetCorrelationId())
	require.Equal(t, "trace", event.GetTraceId())

	result := &DispatchResult{
		Namespace:     "argo",
		WorkflowName:  "workflow",
		Message:       "ok",
		CorrelationId: "corr",
		TraceId:       "trace",
	}
	require.Equal(t, "argo", result.GetNamespace())
	require.Equal(t, "workflow", result.GetWorkflowName())
	require.Equal(t, "ok", result.GetMessage())
	require.Equal(t, "corr", result.GetCorrelationId())
	require.Equal(t, "trace", result.GetTraceId())

	// Exercise protobuf helpers to improve coverage.
	event.ProtoMessage()
	require.NotNil(t, event.ProtoReflect())
	require.NotEmpty(t, event.String())
	require.NotNil(t, event.ProtoReflect().Descriptor())
	descriptor, indexes := event.Descriptor()
	require.NotNil(t, descriptor)
	require.NotEmpty(t, indexes)

	invokeGetters(t, event)
	invokeGetters(t, event.GetUser())
	invokeGetters(t, event.GetMember())
	invokeGetters(t, event.GetResponse())
	invokeGetters(t, result)

	event.Reset()
	require.Equal(t, "", event.GetCommand())
}

func invokeGetters(t *testing.T, target any) {
	t.Helper()
	if target == nil {
		return
	}
	val := reflect.ValueOf(target)
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
