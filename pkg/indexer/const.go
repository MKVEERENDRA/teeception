package indexer

import starknetgoutils "github.com/NethermindEth/starknet.go/utils"

var (
	promptPaidSelector      = starknetgoutils.GetSelectorFromNameFelt("PromptPaid")
	promptConsumedSelector  = starknetgoutils.GetSelectorFromNameFelt("PromptConsumed")
	agentRegisteredSelector = starknetgoutils.GetSelectorFromNameFelt("AgentRegistered")
	transferSelector        = starknetgoutils.GetSelectorFromNameFelt("Transfer")
	tokenAddedSelector      = starknetgoutils.GetSelectorFromNameFelt("TokenAdded")
	tokenRemovedSelector    = starknetgoutils.GetSelectorFromNameFelt("TokenRemoved")
	teeUnencumberedSelector = starknetgoutils.GetSelectorFromNameFelt("TeeUnencumbered")

	isAgentRegisteredSelector = starknetgoutils.GetSelectorFromNameFelt("is_agent_registered")
	getSystemPromptSelector   = starknetgoutils.GetSelectorFromNameFelt("get_system_prompt")
	getPromptPriceSelector    = starknetgoutils.GetSelectorFromNameFelt("get_prompt_price")
	getTokenSelector          = starknetgoutils.GetSelectorFromNameFelt("get_token")
	getNameSelector           = starknetgoutils.GetSelectorFromNameFelt("get_name")
	getCreatorSelector        = starknetgoutils.GetSelectorFromNameFelt("get_creator")
	getEndTimeSelector        = starknetgoutils.GetSelectorFromNameFelt("get_end_time")

	getPrizePoolSelector = starknetgoutils.GetSelectorFromNameFelt("get_prize_pool")
)
