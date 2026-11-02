package sdk

import (
	"context"
	"log/slog"
	"math"
	"net"
	"testing"
	"time"

	"github.com/shirou/gopsutil/v4/mem"
	namespacepb "go.temporal.io/api/namespace/v1"
	workerpb "go.temporal.io/api/worker/v1"
	"go.temporal.io/api/workflowservice/v1"
	sdkclient "go.temporal.io/sdk/client"
	sdklog "go.temporal.io/sdk/log"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
	"google.golang.org/grpc"
)

func TestHostResourcesPreservesSlotLimits(t *testing.T) {
	options, err := withHostResources(worker.Options{
		MaxConcurrentWorkflowTaskExecutionSize:  17,
		MaxConcurrentActivityExecutionSize:      29,
		MaxConcurrentLocalActivityExecutionSize: 31,
		MaxConcurrentNexusTaskExecutionSize:     37,
		MaxConcurrentWorkflowTaskPollers:        2,
		MaxConcurrentActivityTaskPollers:        3,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct {
		slots worker.SlotSupplier
		want  int
	}{
		{options.Tuner.GetWorkflowTaskSlotSupplier(), 17},
		{options.Tuner.GetActivityTaskSlotSupplier(), 29},
		{options.Tuner.GetLocalActivitySlotSupplier(), 31},
		{options.Tuner.GetNexusSlotSupplier(), 37},
	} {
		if got := item.slots.MaxSlots(); got != item.want {
			t.Fatalf("slots = %d, want %d", got, item.want)
		}
		for i := 0; i < item.want; i++ {
			if item.slots.TryReserveSlot(nil) == nil {
				t.Fatalf("slot %d unavailable", i)
			}
		}
		if item.slots.TryReserveSlot(nil) != nil {
			t.Fatal("fixed slot limit exceeded")
		}
	}
	if options.MaxConcurrentWorkflowTaskExecutionSize != 0 || options.MaxConcurrentActivityExecutionSize != 0 || options.MaxConcurrentLocalActivityExecutionSize != 0 || options.MaxConcurrentNexusTaskExecutionSize != 0 {
		t.Fatal("tuner conflicts with legacy execution limits")
	}
	if options.MaxConcurrentWorkflowTaskPollers != 2 || options.MaxConcurrentActivityTaskPollers != 3 {
		t.Fatal("poller settings changed")
	}
}

func TestHostResourcesDefaultsAndExistingTuner(t *testing.T) {
	options, err := withHostResources(worker.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if options.Tuner.GetWorkflowTaskSlotSupplier().MaxSlots() != 1000 {
		t.Fatal("default fixed concurrency changed")
	}
	base, err := worker.NewFixedSizeTuner(worker.FixedSizeTunerOptions{NumWorkflowSlots: 19})
	if err != nil {
		t.Fatal(err)
	}
	custom, err := withHostResources(worker.Options{Tuner: base})
	if err != nil {
		t.Fatal(err)
	}
	if custom.Tuner.GetWorkflowTaskSlotSupplier().MaxSlots() != 19 || custom.Tuner.GetActivityTaskSlotSupplier() != base.GetActivityTaskSlotSupplier() {
		t.Fatal("existing tuner changed")
	}
	first := options.Tuner.GetWorkflowTaskSlotSupplier().(worker.HasSysInfoProvider)
	second := custom.Tuner.GetWorkflowTaskSlotSupplier().(worker.HasSysInfoProvider)
	if first.SysInfoProvider() != second.SysInfoProvider() {
		t.Fatal("workers must share a resource provider")
	}
}

type heartbeatReceiver struct {
	workflowservice.UnimplementedWorkflowServiceServer
	heartbeats chan *workerpb.WorkerHeartbeat
}

func (s *heartbeatReceiver) GetSystemInfo(context.Context, *workflowservice.GetSystemInfoRequest) (*workflowservice.GetSystemInfoResponse, error) {
	return &workflowservice.GetSystemInfoResponse{}, nil
}

func (s *heartbeatReceiver) DescribeNamespace(context.Context, *workflowservice.DescribeNamespaceRequest) (*workflowservice.DescribeNamespaceResponse, error) {
	return &workflowservice.DescribeNamespaceResponse{NamespaceInfo: &namespacepb.NamespaceInfo{
		Name: "host-reporting-proof", Capabilities: &namespacepb.NamespaceInfo_Capabilities{WorkerHeartbeats: true},
	}}, nil
}

func (s *heartbeatReceiver) PollWorkflowTaskQueue(ctx context.Context, _ *workflowservice.PollWorkflowTaskQueueRequest) (*workflowservice.PollWorkflowTaskQueueResponse, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

func (s *heartbeatReceiver) RecordWorkerHeartbeat(_ context.Context, request *workflowservice.RecordWorkerHeartbeatRequest) (*workflowservice.RecordWorkerHeartbeatResponse, error) {
	for _, heartbeat := range request.WorkerHeartbeat {
		select {
		case s.heartbeats <- heartbeat:
		default:
		}
	}
	return &workflowservice.RecordWorkerHeartbeatResponse{}, nil
}

func TestHostResourcesReachSDKHeartbeat(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer()
	receiver := &heartbeatReceiver{heartbeats: make(chan *workerpb.WorkerHeartbeat, 1)}
	workflowservice.RegisterWorkflowServiceServer(server, receiver)
	go server.Serve(listener)
	t.Cleanup(server.Stop)
	client, err := sdkclient.Dial(sdkclient.Options{
		HostPort: listener.Addr().String(), Namespace: "host-reporting-proof",
		Identity:                "host-reporting-proof",
		WorkerHeartbeatInterval: time.Second, Logger: sdklog.NewStructuredLogger(slog.Default()),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)
	w := (&clientFactory{}).NewWorker(client, "host-reporting-proof", worker.Options{LocalActivityWorkerOnly: true})
	w.RegisterWorkflow(func(workflow.Context) error { return nil })
	if err := w.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Stop)
	select {
	case heartbeat := <-receiver.heartbeats:
		host := heartbeat.GetHostInfo()
		if memory := host.GetCurrentHostMemUsage(); memory <= 0 || memory > 1 {
			t.Fatalf("missing or invalid memory in real SDK heartbeat: %f", memory)
		}
		if cpu := host.GetCurrentHostCpuUsage(); cpu < 0 || cpu > 1 {
			t.Fatalf("invalid CPU in real SDK heartbeat: %f", cpu)
		}
		memory, err := mem.VirtualMemory()
		if err != nil {
			t.Fatal(err)
		}
		if math.Abs(float64(host.GetCurrentHostMemUsage())-memory.UsedPercent/100) > 0.01 {
			t.Fatalf("heartbeat memory %f does not match host usage %f", host.GetCurrentHostMemUsage(), memory.UsedPercent/100)
		}
		t.Logf("SDK heartbeat CPU %.2f%%, memory %.2f%%", host.GetCurrentHostCpuUsage()*100, host.GetCurrentHostMemUsage()*100)
	case <-time.After(10 * time.Second):
		t.Fatal("SDK did not send a worker heartbeat")
	}
}
