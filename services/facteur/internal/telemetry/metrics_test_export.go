package telemetry

import "sync"

func resetCommandMetrics() {
	commandMetricsOnce = sync.Once{}
	commandProcessed = nil
	commandFailed = nil
	commandDLQ = nil
	commandLatency = nil
}
