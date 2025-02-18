'use client'

import { useCallback, useMemo, useState } from 'react'
import {
  StarknetTypedContract,
  useAccount,
  useContract,
  useSendTransaction,
} from '@starknet-react/core'
import { ChevronLeft, Loader2 } from 'lucide-react'
import { ConnectPrompt } from '@/components/ConnectPrompt'
import { useTokenBalance } from '@/hooks/useTokenBalance'
import { TEECEPTION_AGENTREGISTRY_ABI } from '@/abis/TEECEPTION_AGENTREGISTRY_ABI'
import { ACTIVE_NETWORK, AGENT_REGISTRY_ADDRESS } from '@/constants'
import { TEECEPTION_ERC20_ABI } from '@/abis/TEECEPTION_ERC20_ABI'
import { uint256 } from 'starknet'
import { AgentLaunchSuccessModal } from '@/components/AgentLaunchSuccessModal'
import Link from 'next/link'

const useAgentForm = (tokenBalance: { balance?: bigint; formatted?: string } | undefined) => {
  const [formState, setFormState] = useState({
    values: {
      agentName: '',
      systemPrompt: '',
      feePerMessage: '',
      initialBalance: '',
      duration: '30',
    },
    errors: {} as Record<string, string>,
    isSubmitting: false,
    transactionStatus: 'idle' as 'idle' | 'submitting' | 'completed' | 'failed',
    transactionHash: null as string | null,
  })

  const validateField = useCallback(
    (name: string, value: string) => {
      switch (name) {
        case 'agentName':
          if (!value.trim()) return 'Agent name is required'
          if (value.length > 31) return 'Agent name must be 31 characters or less'
          break
        case 'feePerMessage':
          const fee = parseFloat(value)
          if (isNaN(fee) || fee < 0) return 'Fee must be a positive number'
          break
        case 'initialBalance':
          const balance = parseFloat(value)
          if (isNaN(balance) || balance < 0) return 'Initial balance must be a positive number'
          if (tokenBalance?.balance) {
            const balanceInSmallestUnit = BigInt(
              balance * Math.pow(10, ACTIVE_NETWORK.tokens[0].decimals)
            )
            if (balanceInSmallestUnit > tokenBalance.balance) {
              return `Insufficient balance. You have ${tokenBalance.formatted} ${ACTIVE_NETWORK.tokens[0].symbol}`
            }
          }
          break
        case 'systemPrompt':
          if (!value.trim()) return 'System prompt is required'
          break
      }
      return ''
    },
    [tokenBalance]
  )

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      const { name, value } = e.target
      setFormState((prev) => ({
        ...prev,
        values: { ...prev.values, [name]: value },
        errors: {
          ...prev.errors,
          [name]: validateField(name, value),
        },
      }))
    },
    [validateField]
  )

  const validateForm = useCallback(() => {
    const newErrors: Record<string, string> = {}
    Object.entries(formState.values).forEach(([key, value]) => {
      const error = validateField(key, value)
      if (error) newErrors[key] = error
    })
    setFormState((prev) => ({ ...prev, errors: newErrors }))
    return Object.keys(newErrors).length === 0
  }, [formState.values, validateField])

  return {
    formState,
    setFormState,
    handleChange,
    validateForm,
  }
}

const useTransactionManager = (
  registry: StarknetTypedContract<typeof TEECEPTION_AGENTREGISTRY_ABI>,
  tokenContract: StarknetTypedContract<typeof TEECEPTION_ERC20_ABI>,
  formData: {
    agentName: string
    systemPrompt: string
    feePerMessage: string
    initialBalance: string
    duration: string
  }
) => {
  const { sendAsync } = useSendTransaction({
    calls: useMemo(() => {
      if (!registry || !tokenContract) return undefined

      const feeNumber = parseFloat(formData.feePerMessage)
      const balanceNumber = parseFloat(formData.initialBalance)
      if (isNaN(feeNumber) || isNaN(balanceNumber)) return undefined

      try {
        const selectedToken = ACTIVE_NETWORK.tokens[0]
        const promptPrice = uint256.bnToUint256(
          BigInt(Math.floor(feeNumber * Math.pow(10, selectedToken.decimals)))
        )
        const initialBalance = uint256.bnToUint256(
          BigInt(Math.floor(balanceNumber * Math.pow(10, selectedToken.decimals)))
        )
        const endTimeSeconds = Math.floor(
          new Date().getTime() / 1000 + parseInt(formData.duration) * 86400
        )

        const calldata = [
          tokenContract.populate('approve', [AGENT_REGISTRY_ADDRESS, initialBalance]),
          registry.populate('register_agent', [
            formData.agentName,
            formData.systemPrompt,
            'gpt-4',
            selectedToken.originalAddress,
            promptPrice,
            initialBalance,
            endTimeSeconds,
          ]),
        ]

        // console.log('Calldata', calldata[1])
        return calldata
      } catch (error) {
        console.error('Error preparing transaction calls:', error)
        return undefined
      }
    }, [registry, tokenContract, formData]),
  })

  return sendAsync
}

const FormInput = ({
  label,
  name,
  error,
  ...props
}: {
  label: string
  name: string
  error?: string
} & React.InputHTMLAttributes<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => (
  <div>
    <label className="block text-sm font-medium mb-2">{label}</label>
    <input
      name={name}
      className="w-full bg-[#12121266] backdrop-blur-lg border border-gray-600 rounded-lg p-3"
      {...props}
    />
    {error && <p className="mt-1 text-sm text-red-500">{error}</p>}
  </div>
)

export default function DefendPage() {
  const { address, account } = useAccount()
  const { balance: tokenBalance } = useTokenBalance('STRK')
  const { contract: registry } = useContract({
    address: AGENT_REGISTRY_ADDRESS as `0x${string}`,
    abi: TEECEPTION_AGENTREGISTRY_ABI,
  })
  const { contract: tokenContract } = useContract({
    address: ACTIVE_NETWORK.tokens[0].address as `0x${string}`,
    abi: TEECEPTION_ERC20_ABI,
  })
  const { formState, setFormState, handleChange, validateForm } = useAgentForm(tokenBalance!)
  const [showSuccess, setShowSuccess] = useState(false)

  const sendAsync = useTransactionManager(registry!, tokenContract!, formState.values)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!validateForm() || !address || !account || !registry || !tokenContract) return
    setFormState((prev) => ({
      ...prev,
      isSubmitting: true,
      transactionStatus: 'submitting',
    }))

    try {
      const response = await sendAsync()
      if (response?.transaction_hash) {
        setFormState((prev) => ({ ...prev, transactionHash: response.transaction_hash }))
        await account.waitForTransaction(response.transaction_hash)
        setFormState((prev) => ({ ...prev, transactionStatus: 'completed' }))
        setShowSuccess(true)
      }
    } catch (error) {
      console.error('Error registering agent:', error)
      setFormState((prev) => ({
        ...prev,
        transactionStatus: 'failed',
        errors: { ...prev.errors, submit: 'Failed to register agent. Please try again.' },
      }))
    } finally {
      setFormState((prev) => ({ ...prev, isSubmitting: false }))
    }
  }

  if (!address) {
    return (
      <ConnectPrompt
        title="Welcome Defender"
        subtitle="One step away from showing your skills"
        theme="defender"
      />
    )
  }

  return (
    <div className="container mx-auto px-4 py-4 pt-24 relative">
      <Link
        href="/"
        className="hidden md:flex items-center gap-1 text-gray-400 hover:text-white transition-colors absolute z-20"
      >
        <ChevronLeft className="w-5 h-5" />
        <span>Home</span>
      </Link>

      <form onSubmit={handleSubmit} className="max-w-2xl mx-auto space-y-6">
        <h1 className="text-4xl font-bold">Deploy Agent</h1>
        <FormInput
          label="Agent Name"
          name="agentName"
          value={formState.values.agentName}
          onChange={handleChange}
          error={formState.errors.agentName}
          placeholder="Enter agent name"
          required
        />

        <div>
          <label className="block text-sm font-medium mb-2">System Prompt</label>
          <textarea
            name="systemPrompt"
            value={formState.values.systemPrompt}
            onChange={handleChange}
            className="w-full bg-[#12121266] backdrop-blur-lg border border-gray-600 rounded-lg p-3 min-h-[200px]"
            placeholder="Enter system prompt..."
            required
          />
          {formState.errors.systemPrompt && (
            <p className="mt-1 text-sm text-red-500">{formState.errors.systemPrompt}</p>
          )}
        </div>

        <FormInput
          label="Fee per Message (STRK)"
          name="feePerMessage"
          type="number"
          value={formState.values.feePerMessage}
          onChange={handleChange}
          error={formState.errors.feePerMessage}
          placeholder="0.00"
          step="0.01"
          min="0"
          required
        />

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm font-medium">Initial Balance (STRK)</label>
            {tokenBalance && (
              <span className="block text-sm text-white/40">
                (Available Balance: {Number(tokenBalance?.formatted || 0).toFixed(2)} STRK)
              </span>
            )}
          </div>
          <input
            type="number"
            name="initialBalance"
            value={formState.values.initialBalance}
            onChange={handleChange}
            className="w-full bg-[#12121266] backdrop-blur-lg border border-gray-600 rounded-lg p-3"
            placeholder="0.00"
            step="0.01"
            min="0"
            required
          />
          {formState.errors.initialBalance && (
            <p className="mt-1 text-sm text-red-500">{formState.errors.initialBalance}</p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">Duration (days)</label>
          <select
            name="duration"
            value={formState.values.duration}
            onChange={handleChange}
            className="w-full bg-[#12121266] backdrop-blur-lg border border-gray-600 rounded-lg p-3"
            required
          >
            <option value="1">1 Day</option>
            <option value="7">1 Week</option>
            <option value="14">2 Weeks</option>
            <option value="30">1 Month</option>
          </select>
        </div>

        <button
          type="submit"
          disabled={formState.isSubmitting}
          className="w-full bg-white text-black rounded-full py-3 font-medium hover:bg-white/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {formState.isSubmitting ? (
            <div className="flex items-center justify-center">
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              Deploying...
            </div>
          ) : (
            'Deploy Agent'
          )}
        </button>

        {formState.errors.submit && (
          <p className="mt-2 text-sm text-red-500 text-center">{formState.errors.submit}</p>
        )}
      </form>
      <AgentLaunchSuccessModal
        open={showSuccess}
        transactionHash={formState.transactionHash!}
        agentName={formState.values.agentName}
        onClose={() => setShowSuccess(false)}
      />
    </div>
  )
}
