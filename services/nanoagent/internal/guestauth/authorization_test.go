package guestauth

import (
	"crypto/ed25519"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"

	pb "github.com/proompteng/lab/services/nanoagent/internal/guestpb"
)

//go:embed testdata/ofz-guest-request-v4.json
var vectorJSON []byte

type vector struct {
	RPCActions map[string]Action `json:"rpcActions"`
	SeedHex    string            `json:"seedHex"`
	PublicKey  string            `json:"publicKey"`
	NowUnixMS  uint64            `json:"nowUnixMs"`
	Body       string            `json:"body"`
	Payload    string            `json:"payload"`
	Proof      Proof             `json:"proof"`
	Valid      []struct {
		Name    string `json:"name"`
		Body    string `json:"body"`
		Payload string `json:"payload"`
		Proof   Proof  `json:"proof"`
	} `json:"valid"`
	Invalid []struct {
		Name  string `json:"name"`
		Proof Proof  `json:"proof"`
	} `json:"invalid"`
}

func fixture(t *testing.T) (vector, *Verifier, Context) {
	t.Helper()
	var v vector
	if err := json.Unmarshal(vectorJSON, &v); err != nil {
		t.Fatal(err)
	}
	key, err := base64.RawURLEncoding.DecodeString(v.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := NewVerifier(key)
	if err != nil {
		t.Fatal(err)
	}
	c, err := verifier.Verify(v.Proof, v.NowUnixMS)
	if err != nil {
		t.Fatal(err)
	}
	return v, verifier, c
}

func binding(c Context, body []byte) Binding {
	return Binding{WorkspaceUID: c.WorkspaceUID, RuntimeEpoch: c.RuntimeEpoch, SlotEpoch: c.SlotEpoch, PodUID: c.PodUID, LeaderOwner: c.LeaderOwner, LeaderGeneration: c.LeaderGeneration, RecoveryGeneration: c.RecoveryGeneration, Action: c.Action, Method: c.Method, Target: c.Target, Body: body}
}

func TestNodeEd25519VectorMatchesGo(t *testing.T) {
	v, verifier, c := fixture(t)
	seed, err := hex.DecodeString(v.SeedHex)
	if err != nil {
		t.Fatal(err)
	}
	key := ed25519.NewKeyFromSeed(seed)
	if base64.RawURLEncoding.EncodeToString(key.Public().(ed25519.PublicKey)) != v.PublicKey {
		t.Fatal("public key differs")
	}
	payload, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	if string(payload) != v.Payload {
		t.Fatal("wire JSON differs")
	}
	signature := ed25519.Sign(key, append([]byte(requestDomain), payload...))
	if base64.RawURLEncoding.EncodeToString(signature) != v.Proof.Signature {
		t.Fatal("signature differs")
	}
	if _, err := verifier.VerifyFor(v.Proof, binding(c, []byte(v.Body)), v.NowUnixMS); err != nil {
		t.Fatal(err)
	}
}

func TestSignedInvalidContractVectorsAreDenied(t *testing.T) {
	v, verifier, _ := fixture(t)
	for _, invalid := range v.Invalid {
		t.Run(invalid.Name, func(t *testing.T) {
			if _, err := verifier.Verify(invalid.Proof, v.NowUnixMS); err == nil {
				t.Fatal("accepted invalid signed proof")
			}
		})
	}
}

func TestAllActorKindsAndScopesRoundTripAcrossLanguages(t *testing.T) {
	v, verifier, _ := fixture(t)
	for _, accepted := range v.Valid {
		t.Run(accepted.Name, func(t *testing.T) {
			c, err := verifier.Verify(accepted.Proof, v.NowUnixMS)
			if err != nil {
				t.Fatal(err)
			}
			payload, err := json.Marshal(c)
			if err != nil {
				t.Fatal(err)
			}
			if string(payload) != accepted.Payload {
				t.Fatal("wire JSON differs")
			}
			if _, err := verifier.VerifyFor(accepted.Proof, binding(c, []byte(accepted.Body)), v.NowUnixMS); err != nil {
				t.Fatal(err)
			}
			if c.Observation != nil {
				if len(accepted.Payload) > MaxContextBytes {
					t.Fatal("maximum canonical target exceeds the bounded proof")
				}
				retargeted := binding(c, []byte(accepted.Body))
				retargeted.Target = "/workspace/another-authorized-root/report.txt"
				if _, err := verifier.VerifyFor(accepted.Proof, retargeted, v.NowUnixMS); err == nil {
					t.Fatal("a request budget authorized another target")
				}
			}
		})
	}
}

func TestAllRuntimeAuthorityAndRequestBindingsAreExact(t *testing.T) {
	v, verifier, c := fixture(t)
	other := "88888888-8888-4888-8888-888888888888"
	mutations := map[string]func(*Binding){
		"workspace":  func(b *Binding) { b.WorkspaceUID = other },
		"runtime":    func(b *Binding) { b.RuntimeEpoch = other },
		"slot":       func(b *Binding) { b.SlotEpoch++ },
		"pod":        func(b *Binding) { b.PodUID = other },
		"leader":     func(b *Binding) { b.LeaderOwner = other },
		"generation": func(b *Binding) { b.LeaderGeneration++ },
		"recovery":   func(b *Binding) { b.RecoveryGeneration++ },
		"action":     func(b *Binding) { b.Action = FilesObserve },
		"method":     func(b *Binding) { b.Method = rpcPrefix + "ReadFile" },
		"target":     func(b *Binding) { b.Target = "/workspace/other.txt" },
		"body":       func(b *Binding) { b.Body = []byte("changed request bytes") },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			b := binding(c, []byte(v.Body))
			mutate(&b)
			if _, err := verifier.VerifyFor(v.Proof, b, v.NowUnixMS); err == nil {
				t.Fatal("accepted changed binding")
			}
		})
	}
}

func TestProofExpiryKeySignatureAndEncoding(t *testing.T) {
	v, verifier, _ := fixture(t)
	if _, err := verifier.Verify(v.Proof, v.NowUnixMS+MaxAdmissionMS); err == nil {
		t.Fatal("accepted expired proof")
	}
	wrong, err := NewVerifier(make([]byte, ed25519.PublicKeySize))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := wrong.Verify(v.Proof, v.NowUnixMS); err == nil {
		t.Fatal("accepted wrong key")
	}
	for _, field := range []string{"context", "signature"} {
		p := v.Proof
		value := &p.Context
		if field == "signature" {
			value = &p.Signature
		}
		first := "A"
		if (*value)[0] == 'A' {
			first = "B"
		}
		*value = first + (*value)[1:]
		if _, err := verifier.Verify(p, v.NowUnixMS); err == nil {
			t.Fatal("accepted tampering")
		}
		p = v.Proof
		if field == "context" {
			p.Context += "="
		} else {
			p.Signature += "="
		}
		if _, err := verifier.Verify(p, v.NowUnixMS); err == nil {
			t.Fatal("accepted padded encoding")
		}
	}
}

func TestNonceConsumptionIsAtomicAndFailClosedAtCapacity(t *testing.T) {
	v, _, c := fixture(t)
	window, err := NewReplayWindow(1)
	if err != nil {
		t.Fatal(err)
	}
	var successes atomic.Int32
	var workers sync.WaitGroup
	for range 32 {
		workers.Go(func() {
			if window.Consume(c, v.NowUnixMS) == nil {
				successes.Add(1)
			}
		})
	}
	workers.Wait()
	if successes.Load() != 1 {
		t.Fatalf("accepted nonce %d times", successes.Load())
	}
	other := c
	other.Nonce = "88888888-8888-4888-8888-888888888888"
	if window.Consume(other, v.NowUnixMS) == nil {
		t.Fatal("accepted nonce beyond capacity")
	}
	if window.Consume(c, c.DeadlineUnixMS) == nil {
		t.Fatal("expired proof reopened after cache eviction")
	}
	other.IssuedAtUnixMS = c.DeadlineUnixMS
	other.DeadlineUnixMS = other.IssuedAtUnixMS + MaxAdmissionMS
	if err := window.Consume(other, other.IssuedAtUnixMS); err != nil {
		t.Fatal(err)
	}
}

func TestMissingAndDuplicateProofHeadersAreDenied(t *testing.T) {
	v, _, _ := fixture(t)
	for _, values := range []struct{ contexts, signatures []string }{
		{}, {contexts: []string{v.Proof.Context}}, {signatures: []string{v.Proof.Signature}},
		{contexts: []string{v.Proof.Context, v.Proof.Context}, signatures: []string{v.Proof.Signature}},
		{contexts: []string{v.Proof.Context}, signatures: []string{v.Proof.Signature, v.Proof.Signature}},
	} {
		if _, err := ProofFromValues(values.contexts, values.signatures); err == nil {
			t.Fatal("accepted missing or repeated proof header")
		}
	}
	if _, err := ProofFromValues([]string{v.Proof.Context}, []string{v.Proof.Signature}); err != nil {
		t.Fatal(err)
	}
}

func TestAdmissionRejectsInvalidBindingBeforeConsumingNonce(t *testing.T) {
	v, _, c := fixture(t)
	key, err := base64.RawURLEncoding.DecodeString(v.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	admission, err := NewAdmission(key, 2)
	if err != nil {
		t.Fatal(err)
	}
	wrong := binding(c, []byte("wrong request"))
	if _, err := admission.Admit(v.Proof, wrong, v.NowUnixMS); err == nil {
		t.Fatal("accepted invalid request binding")
	}
	correct := binding(c, []byte(v.Body))
	if _, err := admission.Admit(v.Proof, correct, v.NowUnixMS); err != nil {
		t.Fatal(err)
	}
	if _, err := admission.Admit(v.Proof, correct, v.NowUnixMS); err == nil {
		t.Fatal("accepted repeated request")
	}
}

func TestEveryDeclaredGuestRPCRequiresAnExplicitAction(t *testing.T) {
	v, _, _ := fixture(t)
	descriptor := pb.NanoagentService_ServiceDesc
	for _, method := range descriptor.Methods {
		if _, err := RPCAction("/" + descriptor.ServiceName + "/" + method.MethodName); err != nil {
			t.Fatal(err)
		}
	}
	for _, stream := range descriptor.Streams {
		if _, err := RPCAction("/" + descriptor.ServiceName + "/" + stream.StreamName); err != nil {
			t.Fatal(err)
		}
	}
	if len(descriptor.Methods)+len(descriptor.Streams) != 19 {
		t.Fatal("unexpected guest RPC inventory")
	}
	if len(v.RPCActions) != 19 {
		t.Fatal("unexpected authorization catalog inventory")
	}
	for operation, expected := range v.RPCActions {
		actual, err := RPCAction(rpcPrefix + operation)
		if err != nil || actual != expected {
			t.Fatalf("RPC action differs from Ofz catalog for %s", operation)
		}
	}
	if _, err := RPCAction(rpcPrefix + "Unknown"); err == nil {
		t.Fatal("accepted unknown guest RPC")
	}
}
