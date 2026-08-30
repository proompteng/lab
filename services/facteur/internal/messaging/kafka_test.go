package messaging_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/proompteng/lab/services/facteur/internal/messaging"
)

func TestNewReaderValidatesInputs(t *testing.T) {
	_, err := messaging.NewReader(messaging.ReaderConfig{Topic: "commands", GroupID: "facteur"})
	require.Error(t, err)
	require.Contains(t, err.Error(), "brokers")

	_, err = messaging.NewReader(messaging.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: "facteur"})
	require.Error(t, err)
	require.Contains(t, err.Error(), "topic")

	_, err = messaging.NewReader(messaging.ReaderConfig{Brokers: []string{"kafka:9092"}, Topic: "commands"})
	require.Error(t, err)
	require.Contains(t, err.Error(), "group id")
}

func TestNewWriterValidatesInputs(t *testing.T) {
	_, err := messaging.NewWriter(messaging.WriterConfig{Topic: "commands"})
	require.Error(t, err)
	require.Contains(t, err.Error(), "brokers")

	_, err = messaging.NewWriter(messaging.WriterConfig{Brokers: []string{"kafka:9092"}})
	require.Error(t, err)
	require.Contains(t, err.Error(), "topic")
}

func TestNewReaderWithSecurityOptions(t *testing.T) {
	reader, err := messaging.NewReader(messaging.ReaderConfig{
		Brokers: []string{"localhost:9092"},
		Topic:   "commands",
		GroupID: "facteur",
		Security: messaging.SecurityConfig{
			TLS:  messaging.TLSOptions{Enabled: true},
			SASL: messaging.SASLOptions{Enabled: true, Mechanism: "plain", Username: "user", Password: "pass"},
		},
	})
	require.NoError(t, err)
	require.NoError(t, reader.Close())
}

func TestNewReaderRejectsUnsupportedSASL(t *testing.T) {
	_, err := messaging.NewReader(messaging.ReaderConfig{
		Brokers: []string{"localhost:9092"},
		Topic:   "commands",
		GroupID: "facteur",
		Security: messaging.SecurityConfig{
			SASL: messaging.SASLOptions{Enabled: true, Mechanism: "scram"},
		},
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "unsupported sasl mechanism")
}
