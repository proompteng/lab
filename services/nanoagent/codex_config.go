package main

import (
	"encoding/json"
	"fmt"
)

func codexGuestThreadParams(method string, params json.RawMessage) (json.RawMessage, error) {
	if method != "thread/start" && method != "thread/resume" {
		return params, nil
	}
	var input map[string]json.RawMessage
	if err := json.Unmarshal(params, &input); err != nil || input == nil {
		return nil, fmt.Errorf("%s requires a thread parameter object", method)
	}
	var config map[string]json.RawMessage
	if raw := input["config"]; len(raw) != 0 {
		if err := json.Unmarshal(raw, &config); err != nil {
			return nil, fmt.Errorf("%s config: %w", method, err)
		}
	}
	if config == nil {
		config = make(map[string]json.RawMessage)
	}
	config["features.apps"] = json.RawMessage("false")
	if raw, found := config["features"]; found {
		var features map[string]json.RawMessage
		if err := json.Unmarshal(raw, &features); err != nil {
			return nil, fmt.Errorf("%s features: %w", method, err)
		}
		if features == nil {
			features = make(map[string]json.RawMessage)
		}
		features["apps"] = json.RawMessage("false")
		config["features"], _ = json.Marshal(features)
	}
	input["config"], _ = json.Marshal(config)
	return json.Marshal(input)
}
