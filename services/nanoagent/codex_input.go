package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"reflect"
	"strings"
	"time"
)

const codexInputMaxBytes = 32768

type codexInputQuestion struct {
	ID       string `json:"id"`
	Question string `json:"question"`
	Header   string `json:"header"`
	IsOther  bool   `json:"isOther"`
	Options  []struct {
		Label       string `json:"label"`
		Description string `json:"description"`
	} `json:"options"`
}
type codexInputParams struct {
	Questions       []codexInputQuestion `json:"questions"`
	Mode            string               `json:"mode"`
	URL             string               `json:"url"`
	RequestedSchema struct {
		Type       string                                `json:"type"`
		Properties map[string]map[string]json.RawMessage `json:"properties"`
		Required   []string                              `json:"required"`
	} `json:"requestedSchema"`
}

func validateCodexInputRequest(method string, raw json.RawMessage) error {
	if len(raw) == 0 || len(raw) > codexInputMaxBytes {
		return errors.New("question request exceeds display limits")
	}
	var params codexInputParams
	if json.Unmarshal(raw, &params) != nil {
		return errors.New("invalid question request")
	}
	if method == "item/tool/requestUserInput" {
		if len(params.Questions) == 0 || len(params.Questions) > 10 {
			return errors.New("invalid question count")
		}
		ids := map[string]bool{}
		for _, question := range params.Questions {
			if question.ID == "" || len(question.ID) > 160 || ids[question.ID] || question.Question == "" || len(question.Question) > 4096 || len(question.Header) > 4096 || len(question.Options) > 20 {
				return errors.New("invalid question")
			}
			ids[question.ID] = true
			for _, option := range question.Options {
				if option.Label == "" || len(option.Label) > 1024 || len(option.Description) > 4096 {
					return errors.New("invalid question option")
				}
			}
		}
		return nil
	}
	if method != "mcpServer/elicitation/request" {
		return errors.New("unsupported question request")
	}
	if params.Mode == "url" {
		target, err := url.Parse(params.URL)
		if err != nil || target.Scheme != "https" || target.Host == "" || target.User != nil {
			return errors.New("unsupported elicitation URL")
		}
		return nil
	}
	if params.Mode != "form" && params.Mode != "openai/form" && params.Mode != "openaiForm" {
		return errors.New("unsupported elicitation mode")
	}
	if params.RequestedSchema.Type != "object" || len(params.RequestedSchema.Properties) > 20 {
		return errors.New("unsupported elicitation schema")
	}
	var envelope struct {
		RequestedSchema map[string]json.RawMessage `json:"requestedSchema"`
	}
	_ = json.Unmarshal(raw, &envelope)
	for key := range envelope.RequestedSchema {
		if key != "type" && key != "properties" && key != "required" && key != "additionalProperties" && key != "$schema" {
			return errors.New("unsupported elicitation schema constraint")
		}
	}
	allowed := map[string]bool{"type": true, "title": true, "description": true, "enum": true, "default": true, "minLength": true, "maxLength": true, "minimum": true, "maximum": true}
	for key, property := range params.RequestedSchema.Properties {
		if key == "" || len(key) > 160 {
			return errors.New("invalid elicitation field")
		}
		for name := range property {
			if !allowed[name] {
				return fmt.Errorf("unsupported elicitation field constraint: %s", name)
			}
		}
		var kind string
		_ = json.Unmarshal(property["type"], &kind)
		if kind != "string" && kind != "boolean" && kind != "number" && kind != "integer" {
			return errors.New("unsupported elicitation field type")
		}
		for _, name := range []string{"title", "description"} {
			if encoded, ok := property[name]; ok {
				var text string
				if json.Unmarshal(encoded, &text) != nil || len(text) > 4096 {
					return errors.New("invalid elicitation label")
				}
			}
		}
		for _, name := range []string{"minLength", "maxLength", "minimum", "maximum"} {
			if encoded, ok := property[name]; ok {
				var limit float64
				if json.Unmarshal(encoded, &limit) != nil || string(encoded) == "null" ||
					((name == "minLength" || name == "maxLength") && (kind != "string" || limit < 0 || limit != math.Trunc(limit))) ||
					((name == "minimum" || name == "maximum") && kind != "number" && kind != "integer") {
					return errors.New("invalid elicitation field constraint")
				}
			}
		}
		if encoded, ok := property["enum"]; ok {
			var choices []json.RawMessage
			if json.Unmarshal(encoded, &choices) != nil || len(choices) == 0 || len(choices) > 20 {
				return errors.New("invalid elicitation choices")
			}
			primitive := map[string]json.RawMessage{"type": property["type"]}
			for _, choice := range choices {
				if err := validateCodexInputValue(choice, primitive); err != nil {
					return errors.New("invalid elicitation choice type")
				}
			}
		}
	}
	for _, key := range params.RequestedSchema.Required {
		if _, ok := params.RequestedSchema.Properties[key]; !ok {
			return errors.New("unknown required elicitation field")
		}
	}
	return nil
}

func codexInputResult(approval codexApproval, raw json.RawMessage) (map[string]any, error) {
	if len(approval.inputParams) == 0 || len(raw) == 0 || len(raw) > codexInputMaxBytes {
		return nil, errors.New("invalid question response")
	}
	if err := validateCodexInputRequest(approval.method, approval.inputParams); err != nil {
		return nil, err
	}
	var params codexInputParams
	_ = json.Unmarshal(approval.inputParams, &params)
	var response map[string]json.RawMessage
	if json.Unmarshal(raw, &response) != nil || response == nil {
		return nil, errors.New("invalid question response JSON")
	}
	if approval.method == "item/tool/requestUserInput" {
		var answers map[string]struct {
			Answers []string `json:"answers"`
		}
		if len(response) != 1 || json.Unmarshal(response["answers"], &answers) != nil || answers == nil {
			return nil, errors.New("invalid question answers")
		}
		if len(answers) != 0 && len(answers) != len(params.Questions) {
			return nil, errors.New("answer every question or explicitly skip")
		}
		for _, question := range params.Questions {
			answer, ok := answers[question.ID]
			if len(answers) == 0 {
				break
			}
			if !ok || len(answer.Answers) != 1 || strings.TrimSpace(answer.Answers[0]) == "" || len(answer.Answers[0]) > 8192 {
				return nil, errors.New("invalid question answer")
			}
			if len(question.Options) > 0 && !question.IsOther {
				found := false
				for _, option := range question.Options {
					if answer.Answers[0] == option.Label {
						found = true
					}
				}
				if !found {
					return nil, errors.New("answer must match an advertised option")
				}
			}
		}
	} else {
		var action string
		if json.Unmarshal(response["action"], &action) != nil {
			return nil, errors.New("elicitation action is required")
		}
		if action != "accept" && action != "decline" && action != "cancel" {
			return nil, errors.New("invalid elicitation action")
		}
		if len(response) > 2 || (len(response) == 2 && response["content"] == nil) {
			return nil, errors.New("invalid elicitation response fields")
		}
		if action != "accept" || params.Mode == "url" {
			if response["content"] != nil {
				return nil, errors.New("this elicitation action cannot include content")
			}
		} else {
			var content map[string]json.RawMessage
			if json.Unmarshal(response["content"], &content) != nil || content == nil {
				return nil, errors.New("elicitation content is required")
			}
			for _, key := range params.RequestedSchema.Required {
				if _, ok := content[key]; !ok {
					return nil, errors.New("required elicitation field is missing")
				}
			}
			for key, value := range content {
				property, ok := params.RequestedSchema.Properties[key]
				if !ok {
					return nil, errors.New("unknown elicitation field")
				}
				if err := validateCodexInputValue(value, property); err != nil {
					return nil, err
				}
			}
		}
	}
	var result map[string]any
	_ = json.Unmarshal(raw, &result)
	return result, nil
}

func validateCodexInputValue(raw json.RawMessage, schema map[string]json.RawMessage) error {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return errors.New("invalid elicitation value")
	}
	var kind string
	_ = json.Unmarshal(schema["type"], &kind)
	switch kind {
	case "string":
		text, ok := value.(string)
		if !ok {
			return errors.New("expected text answer")
		}
		for _, bound := range []string{"minLength", "maxLength"} {
			if encoded, ok := schema[bound]; ok {
				var limit int
				if json.Unmarshal(encoded, &limit) != nil || (bound == "minLength" && len([]rune(text)) < limit) || (bound == "maxLength" && len([]rune(text)) > limit) {
					return errors.New("text answer is outside the requested length")
				}
			}
		}
	case "boolean":
		if _, ok := value.(bool); !ok {
			return errors.New("expected boolean answer")
		}
	case "number", "integer":
		number, ok := value.(float64)
		if !ok || (kind == "integer" && (number != math.Trunc(number) || math.Abs(number) > 9007199254740991)) {
			return errors.New("expected numeric answer")
		}
		for _, bound := range []string{"minimum", "maximum"} {
			if encoded, ok := schema[bound]; ok {
				var limit float64
				if json.Unmarshal(encoded, &limit) != nil || (bound == "minimum" && number < limit) || (bound == "maximum" && number > limit) {
					return errors.New("numeric answer is outside the requested range")
				}
			}
		}
	}
	if encoded, ok := schema["enum"]; ok {
		var choices []any
		if json.Unmarshal(encoded, &choices) != nil {
			return errors.New("invalid answer choices")
		}
		found := false
		for _, choice := range choices {
			if reflect.DeepEqual(choice, value) {
				found = true
			}
		}
		if !found {
			return errors.New("answer must match an advertised option")
		}
	}
	return nil
}

func (supervisor *codexSupervisor) resolveInput(ctx context.Context, id string, raw json.RawMessage) error {
	supervisor.mu.Lock()
	approval, found := supervisor.approvals[id]
	if !found || approval.resolving {
		supervisor.mu.Unlock()
		return errors.New("question was not found or is already being resolved")
	}
	approval.resolving = true
	supervisor.approvals[id] = approval
	supervisor.mu.Unlock()
	result, err := codexInputResult(approval, raw)
	if err != nil {
		supervisor.resetApproval(id, approval)
		return err
	}
	writeContext, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := supervisor.respondRawForGeneration(writeContext, approval.generation, approval.rawID, result); err != nil {
		supervisor.resetApproval(id, approval)
		return err
	}
	supervisor.finishApproval(id, approval)
	return nil
}
