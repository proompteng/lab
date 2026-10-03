package sdk

import (
	"go.temporal.io/sdk/contrib/sysinfo"
	"go.temporal.io/sdk/worker"
)

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
	options.Tuner = reportingTuner{WorkerTuner: options.Tuner, provider: sysinfo.SysInfoProvider()}
	return options, nil
}
