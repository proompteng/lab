package sdk

import (
	"context"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/mem"
	"go.temporal.io/sdk/worker"
)

type hostUsage struct {
	cpu    float64
	memory float64
}

type hostResources struct {
	mu        sync.Mutex
	refreshed time.Time
	last      hostUsage
}

var systemResources = &hostResources{}

func (h *hostResources) sample() (hostUsage, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if time.Since(h.refreshed) < 100*time.Millisecond {
		return h.last, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	cpuUsage, err := cpu.PercentWithContext(ctx, 0, false)
	if err != nil {
		return hostUsage{}, err
	}
	memory, err := mem.VirtualMemoryWithContext(ctx)
	if err != nil {
		return hostUsage{}, err
	}
	h.last = hostUsage{cpu: cpuUsage[0] / 100, memory: memory.UsedPercent / 100}
	h.refreshed = time.Now()
	return h.last, nil
}

func (h *hostResources) CpuUsage(*worker.SysInfoContext) (float64, error) {
	usage, err := h.sample()
	return usage.cpu, err
}

func (h *hostResources) MemoryUsage(*worker.SysInfoContext) (float64, error) {
	usage, err := h.sample()
	return usage.memory, err
}

type reportingTuner struct {
	worker.WorkerTuner
	provider worker.SysInfoProvider
}

func (t reportingTuner) GetWorkflowTaskSlotSupplier() worker.SlotSupplier {
	return reportingSlots{SlotSupplier: t.WorkerTuner.GetWorkflowTaskSlotSupplier(), provider: t.provider}
}

type reportingSlots struct {
	worker.SlotSupplier
	provider worker.SysInfoProvider
}

func (s reportingSlots) SysInfoProvider() worker.SysInfoProvider { return s.provider }

func withHostResources(options worker.Options) (worker.Options, error) {
	if options.Tuner == nil {
		tuner, err := worker.NewFixedSizeTuner(worker.FixedSizeTunerOptions{
			NumWorkflowSlots:      options.MaxConcurrentWorkflowTaskExecutionSize,
			NumActivitySlots:      options.MaxConcurrentActivityExecutionSize,
			NumLocalActivitySlots: options.MaxConcurrentLocalActivityExecutionSize,
			NumNexusSlots:         options.MaxConcurrentNexusTaskExecutionSize,
		})
		if err != nil {
			return options, err
		}
		options.Tuner = tuner
		options.MaxConcurrentWorkflowTaskExecutionSize = 0
		options.MaxConcurrentActivityExecutionSize = 0
		options.MaxConcurrentLocalActivityExecutionSize = 0
		options.MaxConcurrentNexusTaskExecutionSize = 0
	}
	options.Tuner = reportingTuner{WorkerTuner: options.Tuner, provider: systemResources}
	return options, nil
}
