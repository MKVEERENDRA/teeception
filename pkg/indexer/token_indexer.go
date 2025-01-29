package indexer

import (
	"context"
	"log/slog"
	"math/big"
	"sync"
	"time"

	"github.com/NethermindEth/juno/core/felt"
	"golang.org/x/sync/errgroup"

	"github.com/NethermindEth/teeception/pkg/indexer/price"
)

// TokenPriceUpdate is a struct that contains the token price and its update block
type TokenInfo struct {
	MinPromptPrice    *big.Int
	MinInitialBalance *big.Int

	Rate     *big.Int
	RateTime time.Time
}

// TokenIndexer processes token events and tracks token prices.
type TokenIndexer struct {
	dbMu            sync.RWMutex
	db              TokenIndexerDatabase
	registryAddress *felt.Felt
	priceFeed       price.PriceFeed
	priceTickRate   time.Duration
}

// TokenIndexerInitialState is the initial state for a TokenIndexer.
type TokenIndexerInitialState struct {
	Db TokenIndexerDatabase
}

// TokenIndexerConfig is the configuration for a TokenIndexer.
type TokenIndexerConfig struct {
	PriceFeed       price.PriceFeed
	PriceTickRate   time.Duration
	RegistryAddress *felt.Felt
	InitialState    *TokenIndexerInitialState
}

// NewTokenIndexer instantiates a TokenIndexer.
func NewTokenIndexer(cfg *TokenIndexerConfig) *TokenIndexer {
	if cfg.InitialState == nil {
		cfg.InitialState = &TokenIndexerInitialState{
			Db: NewTokenIndexerDatabaseInMemory(0),
		}
	}

	return &TokenIndexer{
		db:              cfg.InitialState.Db,
		priceFeed:       cfg.PriceFeed,
		priceTickRate:   cfg.PriceTickRate,
		registryAddress: cfg.RegistryAddress,
	}
}

// Run starts the main indexing loop in a goroutine. It returns after spawning
// so that you can manage it externally via context cancellation or wait-group.
func (i *TokenIndexer) Run(ctx context.Context, watcher *EventWatcher) error {
	g, ctx := errgroup.WithContext(ctx)
	g.Go(func() error {
		return i.run(ctx, watcher)
	})
	g.Go(func() error {
		return i.updatePricesTask(ctx)
	})
	return g.Wait()
}

func (i *TokenIndexer) run(ctx context.Context, watcher *EventWatcher) error {
	ch := make(chan *EventSubscriptionData, 1000)

	// Subscribe to both token added and removed events
	addedSubID := watcher.Subscribe(EventTokenAdded, ch)
	removedSubID := watcher.Subscribe(EventTokenRemoved, ch)

	defer func() {
		watcher.Unsubscribe(addedSubID)
		watcher.Unsubscribe(removedSubID)
	}()

	for {
		select {
		case data := <-ch:
			i.dbMu.Lock()
			for _, ev := range data.Events {
				switch ev.Type {
				case EventTokenAdded:
					i.onTokenAdded(ev)
				case EventTokenRemoved:
					i.onTokenRemoved(ev)
				}
			}
			i.db.SetLastIndexedBlock(data.ToBlock)
			i.dbMu.Unlock()
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (i *TokenIndexer) updatePricesTask(ctx context.Context) error {
	ticker := time.NewTicker(i.priceTickRate)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			i.dbMu.RLock()
			tokens := i.db.GetTokens()
			i.dbMu.RUnlock()

			token := new(felt.Felt)
			for tokenBytes := range tokens {
				token.SetBytes(tokenBytes[:])
				price, err := i.priceFeed.GetRate(ctx, token)
				if err != nil {
					slog.Error("failed to get token price", "token", token.String(), "error", err)
					continue
				}
				tokens[tokenBytes].Rate = price
				tokens[tokenBytes].RateTime = time.Now()
			}

			i.dbMu.Lock()
			for tokenBytes, info := range tokens {
				i.db.SetTokenInfo(tokenBytes, info)
			}
			i.dbMu.Unlock()

		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (i *TokenIndexer) onTokenAdded(ev *Event) {
	if ev.Raw.FromAddress.Cmp(i.registryAddress) != 0 {
		slog.Warn("ignoring token added event from non-registry address", "address", ev.Raw.FromAddress.String())
		return
	}

	tokenAddedEv, ok := ev.ToTokenAddedEvent()
	if !ok {
		slog.Error("failed to parse token added event")
		return
	}

	i.db.SetTokenInfo(tokenAddedEv.Token.Bytes(), &TokenInfo{
		MinPromptPrice:    tokenAddedEv.MinPromptPrice,
		MinInitialBalance: tokenAddedEv.MinInitialBalance,
	})
}

func (i *TokenIndexer) onTokenRemoved(ev *Event) {
	if ev.Raw.FromAddress.Cmp(i.registryAddress) != 0 {
		slog.Warn("ignoring token removed event from non-registry address", "address", ev.Raw.FromAddress.String())
		return
	}

	tokenRemovedEv, ok := ev.ToTokenRemovedEvent()
	if !ok {
		slog.Error("failed to parse token removed event")
		return
	}

	i.db.SetTokenInfo(tokenRemovedEv.Token.Bytes(), nil)
}

// GetTokenMinPromptPrice returns a token's minimum prompt price, if it exists.
func (i *TokenIndexer) GetTokenMinPromptPrice(token *felt.Felt) (*big.Int, bool) {
	i.dbMu.RLock()
	defer i.dbMu.RUnlock()

	tokenInfo, ok := i.db.GetTokenInfo(token.Bytes())
	if !ok {
		return nil, false
	}

	return tokenInfo.MinPromptPrice, true
}

// GetTokenMinInitialBalance returns a token's minimum initial balance, if it exists.
func (i *TokenIndexer) GetTokenMinInitialBalance(token *felt.Felt) (*big.Int, bool) {
	i.dbMu.RLock()
	defer i.dbMu.RUnlock()

	tokenInfo, ok := i.db.GetTokenInfo(token.Bytes())
	if !ok {
		return nil, false
	}

	return tokenInfo.MinInitialBalance, true
}

// GetTokenRate returns a token's rate, if it exists.
func (i *TokenIndexer) GetTokenRate(token *felt.Felt) (*big.Int, bool) {
	i.dbMu.RLock()
	defer i.dbMu.RUnlock()

	tokenInfo, ok := i.db.GetTokenInfo(token.Bytes())
	if !ok {
		return nil, false
	}

	if tokenInfo.RateTime.IsZero() {
		return nil, false
	}

	return tokenInfo.Rate, true
}

// GetLastIndexedBlock returns the last indexed block.
func (i *TokenIndexer) GetLastIndexedBlock() uint64 {
	i.dbMu.RLock()
	defer i.dbMu.RUnlock()

	return i.db.GetLastIndexedBlock()
}

// ReadState reads the current state of the indexer.
func (i *TokenIndexer) ReadState(f func(TokenIndexerDatabaseReader)) {
	i.dbMu.RLock()
	defer i.dbMu.RUnlock()

	f(i.db)
}
