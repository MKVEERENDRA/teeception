package indexer

import (
	"context"
	"fmt"
	"log/slog"
	"math/big"
	"sync"

	"github.com/NethermindEth/juno/core/felt"
	"github.com/NethermindEth/starknet.go/rpc"
	starknetgoutils "github.com/NethermindEth/starknet.go/utils"
	"github.com/NethermindEth/teeception/pkg/wallet/starknet"
	snaccount "github.com/NethermindEth/teeception/pkg/wallet/starknet"
	"golang.org/x/sync/errgroup"
)

type AgentInfo struct {
	Address      *felt.Felt
	Creator      *felt.Felt
	Name         string
	SystemPrompt string
	PromptPrice  *big.Int
	TokenAddress *felt.Felt
	EndTime      uint64
}

// AgentIndexer processes AgentRegistered events and tracks known agents.
type AgentIndexer struct {
	agentsMu        sync.RWMutex
	db              AgentIndexerDatabase
	registryAddress *felt.Felt
	client          starknet.ProviderWrapper
}

// AgentIndexerInitialState is the initial state for an AgentIndexer.
type AgentIndexerInitialState struct {
	Db AgentIndexerDatabase
}

// AgentIndexerConfig is the configuration for an AgentIndexer.
type AgentIndexerConfig struct {
	RegistryAddress *felt.Felt
	Client          starknet.ProviderWrapper
	InitialState    *AgentIndexerInitialState
}

// NewAgentIndexer instantiates an AgentIndexer.
func NewAgentIndexer(cfg *AgentIndexerConfig) *AgentIndexer {
	if cfg.InitialState == nil {
		cfg.InitialState = &AgentIndexerInitialState{
			Db: NewAgentIndexerDatabaseInMemory(0),
		}
	}

	return &AgentIndexer{
		db:              cfg.InitialState.Db,
		registryAddress: cfg.RegistryAddress,
		client:          cfg.Client,
	}
}

// Run starts the main indexing loop in a goroutine. It returns after spawning
// so that you can manage it externally via context cancellation or wait-group.
func (i *AgentIndexer) Run(ctx context.Context, watcher *EventWatcher) error {
	g, ctx := errgroup.WithContext(ctx)
	g.Go(func() error {
		return i.run(ctx, watcher)
	})
	return g.Wait()
}

func (i *AgentIndexer) run(ctx context.Context, watcher *EventWatcher) error {
	ch := make(chan *EventSubscriptionData, 1000)
	subID := watcher.Subscribe(EventAgentRegistered, ch)
	defer watcher.Unsubscribe(subID)

	for {
		select {
		case data := <-ch:
			i.agentsMu.Lock()
			for _, ev := range data.Events {
				i.onAgentRegistered(ev)
			}
			i.db.SetLastIndexedBlock(data.ToBlock)
			i.agentsMu.Unlock()
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (i *AgentIndexer) onAgentRegistered(ev *Event) {
	if ev.Raw.FromAddress.Cmp(i.registryAddress) != 0 {
		slog.Warn("received agent registered event from non-registry address", "address", ev.Raw.FromAddress)
		return
	}

	agentRegisteredEv, ok := ev.ToAgentRegisteredEvent()
	if !ok {
		slog.Error("failed to parse agent registered event")
		return
	}

	i.db.SetAgentInfo(agentRegisteredEv.Agent.Bytes(), AgentInfo{
		Address:      agentRegisteredEv.Agent,
		Creator:      agentRegisteredEv.Creator,
		Name:         agentRegisteredEv.Name,
		SystemPrompt: agentRegisteredEv.SystemPrompt,
		PromptPrice:  agentRegisteredEv.PromptPrice,
		TokenAddress: agentRegisteredEv.TokenAddress,
		EndTime:      agentRegisteredEv.EndTime,
	})
}

// GetAgentInfo returns an agent's info, if it exists.
func (i *AgentIndexer) GetAgentInfo(addr *felt.Felt) (AgentInfo, bool) {
	i.agentsMu.RLock()
	defer i.agentsMu.RUnlock()

	info, ok := i.db.GetAgentInfo(addr.Bytes())
	return info, ok
}

// AgentsByCreatorResult is the result of a GetAgentsByCreator call.
type AgentsByCreatorResult struct {
	Agents     []AgentInfo
	AgentCount uint64
	LastBlock  uint64
}

// GetAgentsByCreator returns a list of agent addresses created by the given creator address
// within the specified range. start and limit define the pagination window.
func (i *AgentIndexer) GetAgentsByCreator(ctx context.Context, creator *felt.Felt, start uint64, limit uint64) (*AgentsByCreatorResult, bool) {
	i.agentsMu.RLock()
	defer i.agentsMu.RUnlock()

	agents := i.db.GetAddressesByCreator(creator.Bytes())
	if uint64(len(agents)) <= start {
		return nil, false
	}

	end := start + limit
	if end > uint64(len(agents)) {
		end = uint64(len(agents))
	}

	agentInfos := make([]AgentInfo, end-start)
	for idx, addr := range agents[start:end] {
		var ok bool
		agentInfos[idx], ok = i.db.GetAgentInfo(addr)

		if !ok {
			slog.Error("agent not found", "address", addr)
		}
	}

	return &AgentsByCreatorResult{
		Agents:     agentInfos,
		AgentCount: uint64(len(agents)),
		LastBlock:  i.db.GetLastIndexedBlock(),
	}, true
}

// GetOrFetchAgentInfoAtBlock returns an agent's info if it exists.
func (i *AgentIndexer) GetOrFetchAgentInfo(ctx context.Context, addr *felt.Felt, block uint64) (AgentInfo, error) {
	i.agentsMu.RLock()
	defer i.agentsMu.RUnlock()

	info, ok := i.db.GetAgentInfo(addr.Bytes())
	if !ok {
		if i.db.GetLastIndexedBlock() >= block {
			return AgentInfo{}, fmt.Errorf("agent not found")
		}

		info, err := i.fetchAgentInfo(ctx, addr)
		if err != nil {
			return AgentInfo{}, err
		}

		return info, nil
	}

	return info, nil
}

func (i *AgentIndexer) fetchAgentInfo(ctx context.Context, addr *felt.Felt) (AgentInfo, error) {
	var isAgentRegisteredResp []*felt.Felt
	var err error

	if err := i.client.Do(func(provider rpc.RpcProvider) error {
		isAgentRegisteredResp, err = provider.Call(ctx, rpc.FunctionCall{
			ContractAddress:    i.registryAddress,
			EntryPointSelector: isAgentRegisteredSelector,
			Calldata:           []*felt.Felt{addr},
		}, rpc.WithBlockTag("latest"))
		return err
	}); err != nil {
		snaccount.LogRpcError(err)
		return AgentInfo{}, fmt.Errorf("is_agent_registered call failed: %v", err)
	}

	if isAgentRegisteredResp[0].Cmp(new(felt.Felt).SetUint64(1)) != 0 {
		return AgentInfo{}, fmt.Errorf("agent not registered")
	}

	var nameResp []*felt.Felt
	if err := i.client.Do(func(provider rpc.RpcProvider) error {
		nameResp, err = provider.Call(ctx, rpc.FunctionCall{
			ContractAddress:    addr,
			EntryPointSelector: getNameSelector,
			Calldata:           []*felt.Felt{},
		}, rpc.WithBlockTag("latest"))
		return err
	}); err != nil {
		snaccount.LogRpcError(err)
		return AgentInfo{}, fmt.Errorf("get_name call failed: %v", err)
	}

	name, err := starknetgoutils.ByteArrFeltToString(nameResp)
	if err != nil {
		return AgentInfo{}, fmt.Errorf("parse get_name failed: %v", err)
	}

	var getSystemPromptResp []*felt.Felt
	if err := i.client.Do(func(provider rpc.RpcProvider) error {
		getSystemPromptResp, err = provider.Call(ctx, rpc.FunctionCall{
			ContractAddress:    addr,
			EntryPointSelector: getSystemPromptSelector,
			Calldata:           []*felt.Felt{},
		}, rpc.WithBlockTag("latest"))
		return err
	}); err != nil {
		snaccount.LogRpcError(err)
		return AgentInfo{}, fmt.Errorf("system_prompt call failed: %v", err)
	}

	systemPrompt, err := starknetgoutils.ByteArrFeltToString(getSystemPromptResp)
	if err != nil {
		return AgentInfo{}, fmt.Errorf("parse system_prompt failed: %v", err)
	}

	return AgentInfo{
		Address:      addr,
		Name:         name,
		SystemPrompt: systemPrompt,
	}, nil
}

// GetLastIndexedBlock returns the last indexed block.
func (i *AgentIndexer) GetLastIndexedBlock() uint64 {
	i.agentsMu.RLock()
	defer i.agentsMu.RUnlock()

	return i.db.GetLastIndexedBlock()
}

// ReadState reads the current state of the indexer.
func (i *AgentIndexer) ReadState(f func(AgentIndexerDatabaseReader)) {
	i.agentsMu.RLock()
	defer i.agentsMu.RUnlock()

	f(i.db)
}
