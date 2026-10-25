package main

import (
	"context"
	"encoding/json"
	pb "github.com/proompteng/lab/services/nanoagent/internal/guestpb"
	"strings"
	"testing"
)

const testCodexQuestionParams = `{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","questions":[{"id":"target","header":"Target","question":"Where should this run?","isOther":true,"isSecret":false,"options":[{"label":"Staging","description":"Preview environment"},{"label":"Production","description":"Live environment"}]}],"isBlocking":true}`

func TestCodexQuestionsWaitForAnActualUserAnswer(t *testing.T) {
	supervisor, writer := readyCodexSupervisor(t)
	message := codexRPCMessage{ID: json.RawMessage(`17`), Method: "item/tool/requestUserInput", Params: json.RawMessage(testCodexQuestionParams)}
	raw, _ := json.Marshal(message)
	supervisor.handleServerMessage(supervisor.generation, message, raw)
	if len(writer.messages) != 0 || len(supervisor.approvals) != 1 || len(supervisor.buffer) != 1 {
		t.Fatal("question was answered or omitted before user input")
	}
	if err := supervisor.resolveApproval(context.Background(), approvalKey(supervisor.generation, json.RawMessage(`17`)), "approveOnce"); err == nil {
		t.Fatal("question accepted an action approval")
	}
	if err := supervisor.resolveInput(context.Background(), approvalKey(supervisor.generation, json.RawMessage(`17`)), json.RawMessage(`{"answers":{"wrong":{"answers":["Staging"]}}}`)); err == nil {
		t.Fatal("question accepted an unknown ID")
	}
	server := &guestRPCServer{api: &apiServer{codex: supervisor}}
	responseJSON := []byte(`{"answers":{"target":{"answers":["Staging"]}}}`)
	params, _ := json.Marshal(map[string]any{"threadId": "thread-1", "expectedTurnId": "turn-1", "approvalId": approvalKey(supervisor.generation, json.RawMessage(`17`)), "clientUserMessageId": "11111111-1111-4111-8111-111111111111", "response": json.RawMessage(responseJSON)})
	if _, err := server.CodexCall(context.Background(), &pb.CodexRequest{Method: "tengri/resolveApproval", ParamsJson: params}); err != nil {
		t.Fatal(err)
	}
	response := readCodexWireRequest(t, writer)
	if !strings.Contains(string(response.Result), `"Staging"`) || len(supervisor.approvals) != 0 {
		t.Fatalf("answer was not delivered exactly once: %#v", writer.messages)
	}
	if err := supervisor.resolveInput(context.Background(), approvalKey(supervisor.generation, json.RawMessage(`17`)), json.RawMessage(`{"answers":{}}`)); err == nil {
		t.Fatal("resolved question accepted a second answer")
	}
}

func TestCodexElicitationFormsValidateTypedAnswers(t *testing.T) {
	params := json.RawMessage(`{"mode":"form","message":"Choose settings","requestedSchema":{"type":"object","properties":{"name":{"type":"string","minLength":2},"replicas":{"type":"integer","minimum":1,"maximum":3},"enabled":{"type":"boolean"},"region":{"type":"string","enum":["west","east"]}},"required":["name","replicas","enabled","region"]}}`)
	approval := codexApproval{method: "mcpServer/elicitation/request", inputParams: params}
	good := `{"action":"accept","content":{"name":"test","replicas":2,"enabled":true,"region":"west"}}`
	if _, err := codexInputResult(approval, json.RawMessage(good)); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{
		`{"action":"accept","content":{}}`,
		strings.Replace(good, `"replicas":2`, `"replicas":8`, 1),
		strings.Replace(good, `"enabled":true`, `"enabled":"yes"`, 1),
		strings.Replace(good, `"region":"west"`, `"region":"north"`, 1),
		strings.Replace(good, `"name":"test"`, `"name":"x"`, 1),
		`{"action":"accept","content":{"unadvertised":true}}`,
	} {
		if _, err := codexInputResult(approval, json.RawMessage(bad)); err == nil {
			t.Fatalf("accepted invalid form answer: %s", bad)
		}
	}
	if _, err := codexInputResult(approval, json.RawMessage(`{"action":"cancel"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := codexInputResult(codexApproval{method: "item/commandExecution/requestApproval"}, json.RawMessage(good)); err == nil {
		t.Fatal("form response resolved an action approval")
	}
}

func TestCodexInputRequestBoundsAndURLConfirmation(t *testing.T) {
	for _, raw := range []string{`{}`, strings.Repeat("x", codexInputMaxBytes+1), `{"questions":[{"id":"x","question":"First"},{"id":"x","question":"Second"}]}`} {
		if validateCodexInputRequest("item/tool/requestUserInput", json.RawMessage(raw)) == nil {
			t.Fatal("invalid native question was accepted")
		}
	}
	params := json.RawMessage(`{"mode":"url","url":"https://example.test/authorize","message":"Connect account"}`)
	if err := validateCodexInputRequest("mcpServer/elicitation/request", params); err != nil {
		t.Fatal(err)
	}
	approval := codexApproval{method: "mcpServer/elicitation/request", inputParams: params}
	if _, err := codexInputResult(approval, json.RawMessage(`{"action":"accept"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := codexInputResult(approval, json.RawMessage(`{"action":"accept","content":{"password":"not-requested"}}`)); err == nil {
		t.Fatal("URL completion accepted form content")
	}
	if validateCodexInputRequest("mcpServer/elicitation/request", json.RawMessage(`{"mode":"url","url":"javascript:alert(1)"}`)) == nil {
		t.Fatal("unsafe URL accepted")
	}
}

func TestCodexInputRejectsMalformedFormConstraints(t *testing.T) {
	for _, property := range []string{
		`{"type":"string","minLength":"2"}`,
		`{"type":"string","maxLength":-1}`,
		`{"type":"string","minLength":1.5}`,
		`{"type":"string","maximum":3}`,
		`{"type":"number","minimum":null}`,
		`{"type":"boolean","maxLength":2}`,
	} {
		raw := json.RawMessage(`{"mode":"form","requestedSchema":{"type":"object","properties":{"value":` + property + `}}}`)
		if validateCodexInputRequest("mcpServer/elicitation/request", raw) == nil {
			t.Fatalf("accepted malformed field constraint: %s", property)
		}
	}
}
