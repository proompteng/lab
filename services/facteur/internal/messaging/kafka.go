package messaging

import (
	"crypto/tls"
	"fmt"
	"strings"
	"time"

	"github.com/segmentio/kafka-go"
	"github.com/segmentio/kafka-go/sasl/plain"
)

const (
	defaultMinBytes = 1
	defaultMaxBytes = 10 << 20
	defaultMaxWait  = time.Second
)

// ReaderConfig defines the knobs for constructing a Kafka reader.
type ReaderConfig struct {
	Brokers  []string
	Topic    string
	GroupID  string
	MinBytes int
	MaxBytes int
	MaxWait  time.Duration
	Security SecurityConfig
}

// WriterConfig defines the knobs for constructing a Kafka writer.
type WriterConfig struct {
	Brokers  []string
	Topic    string
	Security SecurityConfig
}

// SecurityConfig contains TLS and SASL options.
type SecurityConfig struct {
	TLS  TLSOptions
	SASL SASLOptions
}

// TLSOptions toggles TLS client configuration.
type TLSOptions struct {
	Enabled            bool
	InsecureSkipVerify bool
}

// SASLOptions configures SASL authentication.
type SASLOptions struct {
	Enabled   bool
	Mechanism string
	Username  string
	Password  string
}

// NewReader creates a kafka.Reader from the provided configuration.
func NewReader(cfg ReaderConfig) (*kafka.Reader, error) {
	if len(cfg.Brokers) == 0 {
		return nil, fmt.Errorf("messaging: brokers are required")
	}
	if cfg.Topic == "" {
		return nil, fmt.Errorf("messaging: topic is required")
	}
	if cfg.GroupID == "" {
		return nil, fmt.Errorf("messaging: group id is required")
	}

	readerCfg := kafka.ReaderConfig{
		Brokers:        cfg.Brokers,
		Topic:          cfg.Topic,
		GroupID:        cfg.GroupID,
		MinBytes:       ensureMinBytes(cfg.MinBytes),
		MaxBytes:       ensureMaxBytes(cfg.MaxBytes),
		MaxWait:        ensureMaxWait(cfg.MaxWait),
		CommitInterval: time.Second,
	}

	dialer, err := buildDialer(cfg.Security)
	if err != nil {
		return nil, err
	}
	readerCfg.Dialer = dialer

	return kafka.NewReader(readerCfg), nil
}

// NewWriter creates a kafka.Writer for publishing events (e.g. DLQ).
func NewWriter(cfg WriterConfig) (*kafka.Writer, error) {
	if len(cfg.Brokers) == 0 {
		return nil, fmt.Errorf("messaging: brokers are required")
	}
	if cfg.Topic == "" {
		return nil, fmt.Errorf("messaging: topic is required")
	}

	dialer, err := buildDialer(cfg.Security)
	if err != nil {
		return nil, err
	}

	return kafka.NewWriter(kafka.WriterConfig{
		Brokers:  cfg.Brokers,
		Topic:    cfg.Topic,
		Balancer: &kafka.LeastBytes{},
		Dialer:   dialer,
	}), nil
}

func buildDialer(security SecurityConfig) (*kafka.Dialer, error) {
	dialer := &kafka.Dialer{
		Timeout:   10 * time.Second,
		DualStack: true,
	}

	if security.TLS.Enabled {
		dialer.TLS = &tls.Config{InsecureSkipVerify: security.TLS.InsecureSkipVerify}
	}

	if security.SASL.Enabled {
		mechanism := strings.ToLower(security.SASL.Mechanism)
		if mechanism == "" {
			mechanism = "plain"
		}
		switch mechanism {
		case "plain":
			if security.SASL.Username == "" || security.SASL.Password == "" {
				return nil, fmt.Errorf("messaging: sasl username and password are required for plain mechanism")
			}
			dialer.SASLMechanism = plain.Mechanism{
				Username: security.SASL.Username,
				Password: security.SASL.Password,
			}
		default:
			return nil, fmt.Errorf("messaging: unsupported sasl mechanism %q", security.SASL.Mechanism)
		}
	}

	return dialer, nil
}

func ensureMinBytes(value int) int {
	if value <= 0 {
		return defaultMinBytes
	}
	return value
}

func ensureMaxBytes(value int) int {
	if value <= 0 {
		return defaultMaxBytes
	}
	return value
}

func ensureMaxWait(value time.Duration) time.Duration {
	if value <= 0 {
		return defaultMaxWait
	}
	return value
}
