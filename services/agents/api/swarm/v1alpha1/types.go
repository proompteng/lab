// +kubebuilder:object:generate=true

package v1alpha1

import (
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Mode",type=string,JSONPath=`.spec.mode`
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.conditions[?(@.type=="Ready")].status`
type Swarm struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   SwarmSpec   `json:"spec,omitempty"`
	Status SwarmStatus `json:"status,omitempty"`
}

type SwarmSpec struct {
	Owner        SwarmOwner         `json:"owner"`
	Integrations *SwarmIntegrations `json:"integrations,omitempty"`
	// +kubebuilder:validation:MinItems=1
	Domains []string `json:"domains"`
	// +kubebuilder:validation:MinItems=1
	Objectives []string `json:"objectives"`
	// +kubebuilder:validation:Enum=assisted;lights-out
	Mode      string         `json:"mode"`
	Timezone  string         `json:"timezone,omitempty"`
	Cadence   *SwarmCadence  `json:"cadence,omitempty"`
	Discovery SwarmDiscovery `json:"discovery"`
	Delivery  SwarmDelivery  `json:"delivery"`
	Risk      *SwarmRisk     `json:"risk,omitempty"`
	Mission   *SwarmMission  `json:"mission,omitempty"`
	Execution SwarmExecution `json:"execution"`
}

type SwarmOwner struct {
	ID      string `json:"id"`
	Channel string `json:"channel"`
}

type SwarmIntegrations struct {
	NATS *SwarmNATSIntegration `json:"nats,omitempty"`
}

type SwarmNATSIntegration struct {
	URL           string            `json:"url,omitempty"`
	SubjectPrefix string            `json:"subjectPrefix,omitempty"`
	Channel       string            `json:"channel,omitempty"`
	Personas      SwarmNATSPersonas `json:"personas"`
}

type SwarmNATSPersonas struct {
	Architect SwarmNATSPersona `json:"architect"`
	Engineer  SwarmNATSPersona `json:"engineer"`
	Deployer  SwarmNATSPersona `json:"deployer"`
}

type SwarmNATSPersona struct {
	HumanName      string `json:"humanName"`
	WorkerIdentity string `json:"workerIdentity"`
}

type SwarmCadence struct {
	DiscoverEvery  string `json:"discoverEvery,omitempty"`
	PlanEvery      string `json:"planEvery,omitempty"`
	ImplementEvery string `json:"implementEvery,omitempty"`
	VerifyEvery    string `json:"verifyEvery,omitempty"`
}

type SwarmDiscovery struct {
	// +kubebuilder:validation:Minimum=1
	MinCitations int `json:"minCitations,omitempty"`
	// +kubebuilder:validation:Minimum=0
	// +kubebuilder:validation:Maximum=1
	MinConfidence float64 `json:"minConfidence,omitempty"`
	// +kubebuilder:validation:MinItems=1
	Sources []SwarmDiscoverySource `json:"sources"`
}

type SwarmDiscoverySource struct {
	Name string `json:"name"`
	Kind string `json:"kind,omitempty"`
	URL  string `json:"url,omitempty"`
}

type SwarmDelivery struct {
	RepoAllowlist  []string `json:"repoAllowlist,omitempty"`
	RequiredChecks []string `json:"requiredChecks,omitempty"`
	// +kubebuilder:validation:Enum=auto-merge;merge-queue
	MergePolicy       string        `json:"mergePolicy,omitempty"`
	DeploymentTargets []string      `json:"deploymentTargets"`
	Rollout           *SwarmRollout `json:"rollout,omitempty"`
}

type SwarmRollout struct {
	// +kubebuilder:validation:Enum=canary
	Strategy            string             `json:"strategy"`
	Steps               []SwarmRolloutStep `json:"steps,omitempty"`
	AnalysisTemplateRef string             `json:"analysisTemplateRef,omitempty"`
}

type SwarmRolloutStep struct {
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=100
	SetWeight int    `json:"setWeight"`
	Pause     string `json:"pause"`
}

type SwarmRisk struct {
	BudgetRef         string `json:"budgetRef,omitempty"`
	ApprovalPolicyRef string `json:"approvalPolicyRef,omitempty"`
	// +kubebuilder:validation:Minimum=1
	FreezeAfterFailures int    `json:"freezeAfterFailures,omitempty"`
	FreezeDuration      string `json:"freezeDuration,omitempty"`
}

type SwarmMission struct {
	LedgerRef             string   `json:"ledgerRef,omitempty"`
	SourceDesign          string   `json:"sourceDesign,omitempty"`
	BusinessMetric        string   `json:"businessMetric,omitempty"`
	ValidationContract    []string `json:"validationContract,omitempty"`
	ValueGates            []string `json:"valueGates,omitempty"`
	HandoffRequiredFields []string `json:"handoffRequiredFields,omitempty"`
}

type SwarmExecution struct {
	Discover  SwarmExecutionStage `json:"discover"`
	Plan      SwarmExecutionStage `json:"plan"`
	Implement SwarmExecutionStage `json:"implement"`
	Verify    SwarmExecutionStage `json:"verify"`
}

type SwarmExecutionStage struct {
	Enabled   bool            `json:"enabled,omitempty"`
	Every     string          `json:"every,omitempty"`
	TargetRef *SwarmTargetRef `json:"targetRef,omitempty"`
}

type SwarmTargetRef struct {
	// +kubebuilder:validation:Enum=AgentRun;OrchestrationRun
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace,omitempty"`
}

type SwarmStatus struct {
	Phase                    string                   `json:"phase,omitempty"`
	ObservedGeneration       int64                    `json:"observedGeneration,omitempty"`
	UpdatedAt                *metav1.Time             `json:"updatedAt,omitempty"`
	LastDiscoverAt           *metav1.Time             `json:"lastDiscoverAt,omitempty"`
	LastPlanAt               *metav1.Time             `json:"lastPlanAt,omitempty"`
	LastImplementAt          *metav1.Time             `json:"lastImplementAt,omitempty"`
	LastVerifyAt             *metav1.Time             `json:"lastVerifyAt,omitempty"`
	ActiveMissions           int                      `json:"activeMissions,omitempty"`
	QueuedNeeds              int                      `json:"queuedNeeds,omitempty"`
	Requirements             *SwarmRequirementsStatus `json:"requirements,omitempty"`
	Discoveries24h           int                      `json:"discoveries24h,omitempty"`
	Missions24h              int                      `json:"missions24h,omitempty"`
	AutonomousSuccessRate24h float64                  `json:"autonomousSuccessRate24h,omitempty"`
	LastProductionChangeRef  string                   `json:"lastProductionChangeRef,omitempty"`
	Freeze                   *SwarmFreezeStatus       `json:"freeze,omitempty"`
	// +kubebuilder:pruning:PreserveUnknownFields
	StageStates map[string]apiextensionsv1.JSON `json:"stageStates,omitempty"`
	Conditions  []metav1.Condition              `json:"conditions,omitempty"`
}

type SwarmRequirementsStatus struct {
	Pending               int  `json:"pending,omitempty"`
	Dispatched            int  `json:"dispatched,omitempty"`
	Blocked               int  `json:"blocked,omitempty"`
	AdmissionBlocked      int  `json:"admissionBlocked,omitempty"`
	StageClearanceBlocked int  `json:"stageClearanceBlocked,omitempty"`
	Completed             int  `json:"completed,omitempty"`
	InvalidChannel        int  `json:"invalidChannel,omitempty"`
	Rejected              int  `json:"rejected,omitempty"`
	Duplicates            int  `json:"duplicates,omitempty"`
	Paused                bool `json:"paused,omitempty"`
	// +kubebuilder:pruning:PreserveUnknownFields
	Admission map[string]apiextensionsv1.JSON `json:"admission,omitempty"`
	// +kubebuilder:pruning:PreserveUnknownFields
	StageClearance map[string]apiextensionsv1.JSON `json:"stageClearance,omitempty"`
	PauseReason    string                          `json:"pauseReason,omitempty"`
	PauseMessage   string                          `json:"pauseMessage,omitempty"`
	Error          string                          `json:"error,omitempty"`
}

type SwarmFreezeStatus struct {
	Reason              string       `json:"reason,omitempty"`
	Until               *metav1.Time `json:"until,omitempty"`
	ConsecutiveFailures int          `json:"consecutiveFailures,omitempty"`
	Threshold           int          `json:"threshold,omitempty"`
	EnteredAt           *metav1.Time `json:"enteredAt,omitempty"`
	DurationMs          int          `json:"durationMs,omitempty"`
	// +kubebuilder:pruning:PreserveUnknownFields
	Evidence map[string]apiextensionsv1.JSON `json:"evidence,omitempty"`
}

// +kubebuilder:object:root=true
type SwarmList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []Swarm `json:"items"`
}
