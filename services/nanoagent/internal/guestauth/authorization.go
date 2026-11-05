package guestauth

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"
)

const ContextHeader = "x-tengri-guest-authorization"
const SignatureHeader = "x-tengri-guest-signature"
const ProtocolVersion = 4
const MaxContextBytes = 16 << 10
const MaxAdmissionMS = 5000
const requestDomain = "tengri-guest-request-v4\x00"
const rpcPrefix = "/proompteng.runtime.guest.v1.NanoagentService/"

type Action string

const (
	WorkspaceMetadataRead Action = "ACTION_WORKSPACE_METADATA_READ"
	FilesObserve          Action = "ACTION_FILES_OBSERVE"
	FilesWrite            Action = "ACTION_FILES_WRITE"
	TerminalObserve       Action = "ACTION_TERMINAL_OBSERVE"
	TerminalControl       Action = "ACTION_TERMINAL_CONTROL"
	CodexObserve          Action = "ACTION_CODEX_OBSERVE"
	CodexControl          Action = "ACTION_CODEX_CONTROL"
	BrowserObserve        Action = "ACTION_BROWSER_OBSERVE"
	BrowserControl        Action = "ACTION_BROWSER_CONTROL"
	EditorOpen            Action = "ACTION_EDITOR_OPEN"
	PreviewObserve        Action = "ACTION_PREVIEW_OBSERVE"
	PreviewAccess         Action = "ACTION_PREVIEW_ACCESS"
)

func RPCAction(method string) (Action, error) {
	operation, found := strings.CutPrefix(method, rpcPrefix)
	if !found {
		return "", errors.New("unknown guest RPC")
	}
	switch operation {
	case "GetInfo":
		return WorkspaceMetadataRead, nil
	case "OpenEditor":
		return EditorOpen, nil
	case "OpenBrowser":
		return BrowserControl, nil
	case "StatFile", "ListFiles", "ReadFile", "SearchFiles", "WatchFiles":
		return FilesObserve, nil
	case "WriteFile", "CreateDirectory", "MoveFile", "DeleteFile":
		return FilesWrite, nil
	case "ListTerminals":
		return TerminalObserve, nil
	case "CreateTerminal", "TerminateTerminal", "AttachTerminal":
		return TerminalControl, nil
	case "CodexCall", "CodexLogin", "WatchCodexEvents":
		return CodexControl, nil
	default:
		return "", errors.New("unknown guest RPC")
	}
}

func RequestAction(method string) (Action, error) {
	switch method {
	case "HTTP GET", "HTTP HEAD", "HTTP POST", "HTTP PUT", "HTTP PATCH", "HTTP DELETE", "HTTP OPTIONS":
		return PreviewAccess, nil
	default:
		return RPCAction(method)
	}
}

type Actor struct {
	Kind      string `json:"kind"`
	Subject   string `json:"subject"`
	SessionID string `json:"sessionId,omitempty"`
	GrantID   string `json:"grantId,omitempty"`
	Purpose   string `json:"purpose,omitempty"`
}

// Ofz checks the full policy before the controller signs one exact target. The
// guest receives only the output limits for that request, never a reusable policy.
type ObservationBudget struct {
	MaxBytes uint32 `json:"maxBytes"`
	MaxItems uint32 `json:"maxItems"`
}

func (a Action) observer() bool {
	switch a {
	case WorkspaceMetadataRead, FilesObserve, TerminalObserve, CodexObserve, BrowserObserve, PreviewObserve:
		return true
	}
	return false
}

func cleanFilePath(path string) bool {
	if !strings.HasPrefix(path, "/workspace/") || !boundedText(path, 4096) || strings.Contains(path, "\\") {
		return false
	}
	for _, part := range strings.Split(path, "/")[1:] {
		switch part {
		case "", ".", "..", ".ssh", ".aws", ".kube", ".codex", ".config", ".git", ".npmrc", ".netrc", ".pypirc", "credentials.json", "auth.json", ".env":
			return false
		}
		if strings.HasPrefix(part, ".env.") {
			return false
		}
	}
	return true
}

func observationTarget(action Action, target string) bool {
	switch action {
	case WorkspaceMetadataRead, PreviewObserve:
		return target == ""
	case FilesObserve:
		return cleanFilePath(target)
	case TerminalObserve, CodexObserve:
		return target != "" && boundedText(target, 128) && !strings.ContainsAny(target, "/\\")
	case BrowserObserve:
		return target == "status" || target == "screenshot"
	}
	return false
}

type Context struct {
	ProtocolVersion    uint32             `json:"protocolVersion"`
	Actor              Actor              `json:"actor"`
	Action             Action             `json:"action"`
	WorkspaceUID       string             `json:"workspaceUid"`
	RuntimeEpoch       string             `json:"runtimeEpoch"`
	SlotEpoch          uint64             `json:"slotEpoch"`
	PodUID             string             `json:"podUid"`
	LeaderOwner        string             `json:"leaderOwner"`
	LeaderGeneration   uint64             `json:"leaderGeneration"`
	RecoveryGeneration uint64             `json:"recoveryGeneration"`
	AuditReceiptID     string             `json:"auditReceiptId"`
	Method             string             `json:"method"`
	Target             string             `json:"target"`
	BodySHA256         string             `json:"bodySha256"`
	IssuedAtUnixMS     uint64             `json:"issuedAtUnixMs"`
	DeadlineUnixMS     uint64             `json:"deadlineUnixMs"`
	Nonce              string             `json:"nonce"`
	Observation        *ObservationBudget `json:"observation,omitempty"`
}

type Binding struct {
	WorkspaceUID       string
	RuntimeEpoch       string
	SlotEpoch          uint64
	PodUID             string
	LeaderOwner        string
	LeaderGeneration   uint64
	RecoveryGeneration uint64
	Action             Action
	Method             string
	Target             string
	Body               []byte
}

// Leadership and recovery freshness are enforced by the host supervisor against
// shared SQL. Guest root publishes only the runtime that it has actually resumed.
type RuntimeClaim struct {
	WorkspaceUID string `json:"workspaceUid"`
	RuntimeEpoch string `json:"runtimeEpoch"`
	SlotEpoch    uint64 `json:"slotEpoch"`
	PodUID       string `json:"podUid"`
}

func (claim RuntimeClaim) Validate() error {
	if !canonicalUUID(claim.WorkspaceUID) || !canonicalUUID(claim.RuntimeEpoch) || !canonicalUUID(claim.PodUID) || claim.SlotEpoch == 0 {
		return errors.New("guest root has not published a valid runtime claim")
	}
	return nil
}

type RequestBinding struct {
	RecoveryGeneration uint64
	Action             Action
	Method             string
	Target             string
	Body               []byte
}

type Proof struct {
	Context   string `json:"context"`
	Signature string `json:"signature"`
}

func ProofFromValues(contexts, signatures []string) (Proof, error) {
	if len(contexts) != 1 || len(signatures) != 1 {
		return Proof{}, errors.New("guest authorization requires one context and signature")
	}
	return Proof{Context: contexts[0], Signature: signatures[0]}, nil
}

type Admission struct {
	verifier *Verifier
	replay   *ReplayWindow
}

func NewAdmission(key []byte, nonceLimit int) (*Admission, error) {
	verifier, err := NewVerifier(key)
	if err != nil {
		return nil, err
	}
	replay, err := NewReplayWindow(nonceLimit)
	if err != nil {
		return nil, err
	}
	return &Admission{verifier: verifier, replay: replay}, nil
}

// VerifyProof bounds opening reads. AdmitGuest must still bind the actual request and consume its nonce.
func (a *Admission) VerifyProof(proof Proof, nowMS uint64) (Context, error) {
	return a.verifier.Verify(proof, nowMS)
}

func (a *Admission) Admit(proof Proof, binding Binding, nowMS uint64) (Context, error) {
	c, err := a.verifier.VerifyFor(proof, binding, nowMS)
	if err != nil {
		return Context{}, err
	}
	if err := a.replay.Consume(c, nowMS); err != nil {
		return Context{}, err
	}
	return c, nil
}

func (a *Admission) AdmitGuest(proof Proof, claim RuntimeClaim, request RequestBinding, nowMS uint64) (Context, error) {
	if err := claim.Validate(); err != nil {
		return Context{}, err
	}
	c, err := a.verifier.Verify(proof, nowMS)
	if err != nil {
		return Context{}, err
	}
	if request.RecoveryGeneration == 0 || c.RecoveryGeneration != request.RecoveryGeneration {
		return Context{}, errors.New("guest request belongs to a different recovery generation")
	}
	if c.WorkspaceUID != claim.WorkspaceUID || c.RuntimeEpoch != claim.RuntimeEpoch || c.SlotEpoch != claim.SlotEpoch || c.PodUID != claim.PodUID {
		return Context{}, errors.New("guest request does not match the resumed runtime")
	}
	if c.Action != request.Action || c.Method != request.Method || c.Target != request.Target || c.BodySHA256 != BodySHA256(request.Body) {
		return Context{}, errors.New("guest request differs from its authorization")
	}
	if err := a.replay.Consume(c, nowMS); err != nil {
		return Context{}, err
	}
	return c, nil
}

func canonicalUUID(value string) bool {
	if len(value) != 36 || value == "00000000-0000-0000-0000-000000000000" {
		return false
	}
	for i, c := range value {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
		} else if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

func boundedText(value string, limit int) bool {
	if len(value) > limit {
		return false
	}
	for _, c := range value {
		if unicode.IsControl(c) || c == utf8.RuneError {
			return false
		}
	}
	return true
}

func hashText(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, c := range value {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

func BodySHA256(body []byte) string {
	hash := sha256.Sum256(body)
	return hex.EncodeToString(hash[:])
}

func (c Context) Validate(nowMS uint64) error {
	if c.ProtocolVersion != ProtocolVersion {
		return errors.New("unsupported guest authorization protocol")
	}
	for _, uid := range []string{c.WorkspaceUID, c.RuntimeEpoch, c.PodUID, c.LeaderOwner, c.AuditReceiptID, c.Nonce} {
		if !canonicalUUID(uid) {
			return errors.New("invalid guest authorization binding")
		}
	}
	if c.SlotEpoch == 0 || c.LeaderGeneration == 0 || c.LeaderGeneration > math.MaxInt64 || c.RecoveryGeneration == 0 {
		return errors.New("invalid guest fencing generation")
	}
	switch c.Action {
	case WorkspaceMetadataRead, FilesObserve, FilesWrite, TerminalObserve, TerminalControl, CodexObserve, CodexControl, BrowserObserve, BrowserControl, EditorOpen, PreviewObserve, PreviewAccess:
	default:
		return errors.New("unknown guest action")
	}
	switch c.Actor.Kind {
	case "human":
		if !hashText(c.Actor.Subject) || !canonicalUUID(c.Actor.SessionID) || c.Actor.GrantID != "" || c.Actor.Purpose != "" {
			return errors.New("invalid human authorization binding")
		}
	case "agent":
		if !canonicalUUID(c.Actor.Subject) || !canonicalUUID(c.Actor.GrantID) || c.Actor.SessionID != "" || c.Actor.Purpose != "" {
			return errors.New("invalid agent authorization binding")
		}
		if !c.Action.observer() || c.Observation == nil {
			return errors.New("agent authorization requires a bounded diagnostic action")
		}
	case "workload":
		if c.Observation != nil {
			return errors.New("workload maintenance cannot carry an observation budget")
		}
		if c.Actor.Subject != "spiffe://proompteng.ai/ns/tengri/sa/tengri" || c.Actor.SessionID != "" || c.Actor.GrantID != "" {
			return errors.New("invalid workload authorization binding")
		}
		if !(c.Actor.Purpose == "probe" && c.Action == WorkspaceMetadataRead && c.Method == rpcPrefix+"GetInfo" && c.Target == "" || c.Actor.Purpose == "terminalCleanup" && c.Action == TerminalControl && c.Method == rpcPrefix+"TerminateTerminal" && c.Target != "") {
			return errors.New("workload authorization exceeds its maintenance purpose")
		}
	default:
		return errors.New("unknown guest actor")
	}
	expected, err := RequestAction(c.Method)
	if err != nil || expected != c.Action {
		return errors.New("guest RPC does not permit this action")
	}
	if !boundedText(c.Target, 4096) || !hashText(c.BodySHA256) {
		return errors.New("invalid guest request target or hash")
	}
	maxIssued := nowMS + 1000
	if maxIssued < nowMS {
		maxIssued = math.MaxUint64
	}
	if c.IssuedAtUnixMS == 0 || c.IssuedAtUnixMS > maxIssued || c.DeadlineUnixMS <= nowMS || c.DeadlineUnixMS <= c.IssuedAtUnixMS || c.DeadlineUnixMS-c.IssuedAtUnixMS > MaxAdmissionMS {
		return errors.New("guest authorization expired or outside its deadline")
	}
	if budget := c.Observation; budget != nil {
		if !observationTarget(c.Action, c.Target) {
			return errors.New("invalid guest observation target")
		}
		if budget.MaxBytes == 0 || budget.MaxBytes > 1<<20 || budget.MaxItems == 0 || budget.MaxItems > 200 {
			return errors.New("invalid guest observation bounds")
		}
	}
	return nil
}

func (c Context) RequireBinding(b Binding) error {
	if c.WorkspaceUID != b.WorkspaceUID || c.RuntimeEpoch != b.RuntimeEpoch || c.SlotEpoch != b.SlotEpoch || c.PodUID != b.PodUID || c.LeaderOwner != b.LeaderOwner || c.LeaderGeneration != b.LeaderGeneration || c.RecoveryGeneration != b.RecoveryGeneration {
		return errors.New("guest runtime or authority changed")
	}
	if c.Action != b.Action || c.Method != b.Method || c.Target != b.Target || c.BodySHA256 != BodySHA256(b.Body) {
		return errors.New("guest request differs from its authorization")
	}
	return nil
}

type Verifier struct{ key [ed25519.PublicKeySize]byte }

func NewVerifier(key []byte) (*Verifier, error) {
	if len(key) != ed25519.PublicKeySize {
		return nil, errors.New("guest verification key must contain 32 bytes")
	}
	v := new(Verifier)
	copy(v.key[:], key)
	return v, nil
}

func (v *Verifier) Verify(proof Proof, nowMS uint64) (Context, error) {
	var c Context
	if len(proof.Context) > MaxContextBytes*4/3+4 || len(proof.Signature) != 86 {
		return c, errors.New("invalid guest proof size")
	}
	payload, err := base64.RawURLEncoding.Strict().DecodeString(proof.Context)
	if err != nil || len(payload) > MaxContextBytes || base64.RawURLEncoding.EncodeToString(payload) != proof.Context {
		return c, errors.New("invalid guest proof encoding")
	}
	signature, err := base64.RawURLEncoding.Strict().DecodeString(proof.Signature)
	if err != nil || base64.RawURLEncoding.EncodeToString(signature) != proof.Signature {
		return c, errors.New("invalid guest signature encoding")
	}
	if !ed25519.Verify(v.key[:], append([]byte(requestDomain), payload...), signature) {
		return c, errors.New("invalid guest authorization signature")
	}
	if !utf8.Valid(payload) {
		return c, errors.New("invalid guest context text")
	}
	if err := requireUniqueFields(payload); err != nil {
		return c, err
	}
	if err := requireWireShape(payload); err != nil {
		return c, err
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&c); err != nil {
		return Context{}, errors.New("invalid guest authorization context")
	}
	if err := c.Validate(nowMS); err != nil {
		return Context{}, err
	}
	return c, nil
}

func requireWireShape(payload []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(payload, &fields); err != nil {
		return err
	}
	required := []string{"protocolVersion", "actor", "action", "workspaceUid", "runtimeEpoch", "slotEpoch", "podUid", "leaderOwner", "leaderGeneration", "recoveryGeneration", "auditReceiptId", "method", "target", "bodySha256", "issuedAtUnixMs", "deadlineUnixMs", "nonce"}
	if err := exactFields(fields, required, "observation"); err != nil {
		return err
	}
	var actor map[string]json.RawMessage
	if err := json.Unmarshal(fields["actor"], &actor); err != nil {
		return err
	}
	var kind string
	if err := json.Unmarshal(actor["kind"], &kind); err != nil {
		return err
	}
	var identityField string
	switch kind {
	case "human":
		identityField = "sessionId"
	case "agent":
		identityField = "grantId"
	case "workload":
		identityField = "purpose"
	default:
		return errors.New("unknown guest actor")
	}
	if err := exactFields(actor, []string{"kind", "subject", identityField}, ""); err != nil {
		return err
	}
	if budget, found := fields["observation"]; found && !bytes.Equal(bytes.TrimSpace(budget), []byte("null")) {
		var values map[string]json.RawMessage
		if err := json.Unmarshal(budget, &values); err != nil {
			return err
		}
		if err := exactFields(values, []string{"maxBytes", "maxItems"}, ""); err != nil {
			return err
		}
		for _, field := range []string{"maxBytes", "maxItems"} {
			if bytes.Equal(bytes.TrimSpace(values[field]), []byte("null")) {
				return errors.New("null guest observation budget field")
			}
		}
	}
	for _, name := range required {
		if bytes.Equal(bytes.TrimSpace(fields[name]), []byte("null")) {
			return errors.New("null guest context field")
		}
	}
	return nil
}

func exactFields(fields map[string]json.RawMessage, required []string, optional string) error {
	for _, name := range required {
		if _, found := fields[name]; !found {
			return errors.New("missing guest context field")
		}
	}
	for name := range fields {
		if name == optional {
			continue
		}
		found := false
		for _, expected := range required {
			if name == expected {
				found = true
				break
			}
		}
		if !found {
			return errors.New("unknown guest context field")
		}
	}
	return nil
}

func (v *Verifier) VerifyFor(proof Proof, binding Binding, nowMS uint64) (Context, error) {
	c, err := v.Verify(proof, nowMS)
	if err != nil {
		return Context{}, err
	}
	if err := c.RequireBinding(binding); err != nil {
		return Context{}, err
	}
	return c, nil
}

func requireUniqueFields(payload []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	var walk func(int) error
	walk = func(depth int) error {
		if depth > 4 {
			return errors.New("guest context is too deeply nested")
		}
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delimiter, structured := token.(json.Delim)
		if !structured {
			return nil
		}
		switch delimiter {
		case '{':
			seen := make(map[string]bool)
			for decoder.More() {
				key, err := decoder.Token()
				if err != nil {
					return err
				}
				name, ok := key.(string)
				if !ok || seen[name] {
					return errors.New("duplicate guest context field")
				}
				seen[name] = true
				if err := walk(depth + 1); err != nil {
					return err
				}
			}
		case '[':
			for decoder.More() {
				if err := walk(depth + 1); err != nil {
					return err
				}
			}
		default:
			return errors.New("invalid guest context structure")
		}
		_, err = decoder.Token()
		return err
	}
	if err := walk(0); err != nil {
		return err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return errors.New("trailing guest context data")
	}
	return nil
}

type ReplayWindow struct {
	mu    sync.Mutex
	limit int
	used  map[string]uint64
}

func NewReplayWindow(limit int) (*ReplayWindow, error) {
	if limit < 1 || limit > 100_000 {
		return nil, errors.New("invalid guest nonce capacity")
	}
	return &ReplayWindow{limit: limit, used: make(map[string]uint64)}, nil
}

func (window *ReplayWindow) Consume(c Context, nowMS uint64) error {
	if err := c.Validate(nowMS); err != nil {
		return err
	}
	window.mu.Lock()
	defer window.mu.Unlock()
	for nonce, deadline := range window.used {
		if deadline <= nowMS {
			delete(window.used, nonce)
		}
	}
	if _, used := window.used[c.Nonce]; used {
		return errors.New("guest request nonce already used")
	}
	if len(window.used) >= window.limit {
		return errors.New("guest nonce capacity exhausted")
	}
	window.used[c.Nonce] = c.DeadlineUnixMS
	return nil
}
