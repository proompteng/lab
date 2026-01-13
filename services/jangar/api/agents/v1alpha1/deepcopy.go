package v1alpha1

import (
	"encoding/json"

	"k8s.io/apimachinery/pkg/runtime"
)

func deepCopyJSON(in any, out any) {
	if in == nil || out == nil {
		return
	}
	data, err := json.Marshal(in)
	if err != nil {
		return
	}
	_ = json.Unmarshal(data, out)
}

func (in *Agent) DeepCopyObject() runtime.Object {
	if in == nil {
		return nil
	}
	out := new(Agent)
	deepCopyJSON(in, out)
	return out
}

func (in *AgentList) DeepCopyObject() runtime.Object {
	if in == nil {
		return nil
	}
	out := new(AgentList)
	deepCopyJSON(in, out)
	return out
}

func (in *AgentRun) DeepCopyObject() runtime.Object {
	if in == nil {
		return nil
	}
	out := new(AgentRun)
	deepCopyJSON(in, out)
	return out
}

func (in *AgentRunList) DeepCopyObject() runtime.Object {
	if in == nil {
		return nil
	}
	out := new(AgentRunList)
	deepCopyJSON(in, out)
	return out
}

func (in *AgentProvider) DeepCopyObject() runtime.Object {
	if in == nil {
		return nil
	}
	out := new(AgentProvider)
	deepCopyJSON(in, out)
	return out
}

func (in *AgentProviderList) DeepCopyObject() runtime.Object {
	if in == nil {
		return nil
	}
	out := new(AgentProviderList)
	deepCopyJSON(in, out)
	return out
}

func (in *ImplementationSpec) DeepCopyObject() runtime.Object {
	if in == nil {
		return nil
	}
	out := new(ImplementationSpec)
	deepCopyJSON(in, out)
	return out
}

func (in *ImplementationSpecList) DeepCopyObject() runtime.Object {
	if in == nil {
		return nil
	}
	out := new(ImplementationSpecList)
	deepCopyJSON(in, out)
	return out
}

func (in *ImplementationSource) DeepCopyObject() runtime.Object {
	if in == nil {
		return nil
	}
	out := new(ImplementationSource)
	deepCopyJSON(in, out)
	return out
}

func (in *ImplementationSourceList) DeepCopyObject() runtime.Object {
	if in == nil {
		return nil
	}
	out := new(ImplementationSourceList)
	deepCopyJSON(in, out)
	return out
}

func (in *Memory) DeepCopyObject() runtime.Object {
	if in == nil {
		return nil
	}
	out := new(Memory)
	deepCopyJSON(in, out)
	return out
}

func (in *MemoryList) DeepCopyObject() runtime.Object {
	if in == nil {
		return nil
	}
	out := new(MemoryList)
	deepCopyJSON(in, out)
	return out
}
