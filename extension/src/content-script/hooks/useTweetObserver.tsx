import { useEffect, useCallback, useRef } from 'react'
import { SELECTORS } from '../constants/selectors'
import { extractAgentName } from '../utils/twitter'
import { checkTweetPaid, getAgentAddressByName } from '../utils/contracts'
import { debug } from '../utils/debug'
import { TWITTER_CONFIG } from '../config/starknet'
import { Contract } from 'starknet'
import { TEECEPTION_AGENT_ABI } from '@/abis/TEECEPTION_AGENT_ABI'
import { useAccount } from '@starknet-react/core'

interface TweetData {
  id: string
  isPaid: boolean
  agentName: string
  overlayContainer?: HTMLDivElement
}

// Use sessionStorage to persist cache across page navigations
const getTweetCache = () => {
  try {
    const cached = sessionStorage.getItem('tweetCache')
    return cached ? new Map<string, TweetData>(JSON.parse(cached)) : new Map<string, TweetData>()
  } catch (error) {
    debug.error('TweetObserver', 'Error reading tweet cache', error)
    return new Map<string, TweetData>()
  }
}

const setTweetCache = (cache: Map<string, TweetData>) => {
  try {
    const serializable = Array.from(cache.entries()).map(([key, value]) => {
      // Don't serialize DOM elements
      const { overlayContainer, ...rest } = value
      return [key, rest]
    })
    sessionStorage.setItem('tweetCache', JSON.stringify(serializable))
  } catch (error) {
    debug.error('TweetObserver', 'Error saving tweet cache', error)
  }
}

const TEMP_PAID_STORAGE_KEY = 'tempPaidTweets'
const TEMP_PAID_EXPIRY = 5 * 60 * 1000 // 5 minutes in milliseconds

interface TempPaidTweet {
  tweetId: string
  timestamp: number
}

const getTempPaidTweets = (): Map<string, number> => {
  try {
    const stored = localStorage.getItem(TEMP_PAID_STORAGE_KEY)
    if (!stored) return new Map()
    
    const parsed: TempPaidTweet[] = JSON.parse(stored)
    const now = Date.now()
    
    // Filter out expired entries
    const valid = parsed.filter(entry => now - entry.timestamp < TEMP_PAID_EXPIRY)
    const map = new Map(valid.map(entry => [entry.tweetId, entry.timestamp]))
    
    // If we filtered any entries, update storage
    if (valid.length !== parsed.length) {
      setTempPaidTweets(map)
    }
    
    return map
  } catch (error) {
    debug.error('TweetObserver', 'Error reading temp paid tweets', error)
    return new Map()
  }
}

const setTempPaidTweets = (tweets: Map<string, number>) => {
  try {
    const data: TempPaidTweet[] = Array.from(tweets.entries())
      .map(([tweetId, timestamp]) => ({ tweetId, timestamp }))
    localStorage.setItem(TEMP_PAID_STORAGE_KEY, JSON.stringify(data))
  } catch (error) {
    debug.error('TweetObserver', 'Error saving temp paid tweets', error)
  }
}

const markTweetAsPaid = (tweetId: string) => {
  const tweets = getTempPaidTweets()
  tweets.set(tweetId, Date.now())
  setTempPaidTweets(tweets)
}

export const useTweetObserver = (
  onPayClick: (tweetId: string, agentName: string) => void,
  currentUser: string
) => {
  const { account } = useAccount()
  const tweetCache = useRef<Map<string, TweetData>>(getTweetCache())
  const observer = useRef<MutationObserver | null>(null)
  const processingTweets = useRef<Set<string>>(new Set())
  const processTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const lastProcessTime = useRef<Map<string, number>>(new Map())
  const unpaidTweets = useRef<Set<string>>(new Set())

  const createAttemptsList = (attempts: number[], tweetId: string) => {
    const dropdown = document.createElement('select')
    dropdown.className = 'bg-transparent text-green-500 border border-green-500 rounded px-2 py-1 text-sm ml-2'
    dropdown.style.cssText = `
      background-color: rgba(0, 200, 83, 0.1);
      border: 1px solid rgb(0, 200, 83);
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 13px;
      color: rgb(0, 200, 83);
      cursor: pointer;
      outline: none;
    `
    
    const defaultOption = document.createElement('option')
    defaultOption.value = ''
    defaultOption.textContent = `${attempts.length} Attempt${attempts.length !== 1 ? 's' : ''}`
    dropdown.appendChild(defaultOption)
    
    attempts.forEach((promptId, index) => {
      const option = document.createElement('option')
      option.value = promptId.toString()
      option.textContent = `Attempt ${index + 1}`
      dropdown.appendChild(option)
    })
    
    dropdown.addEventListener('change', (e) => {
      const promptId = (e.target as HTMLSelectElement).value
      if (promptId) {
        window.open(`https://teeception.ai/tweet/${tweetId}/prompt/${promptId}`, '_blank')
      }
    })
    
    return dropdown
  }

  const shouldProcessTweet = (tweet: HTMLElement, tweetId: string): boolean => {
    // Don't process if already processing
    if (processingTweets.current.has(tweetId)) return false

    // Check if we've processed this tweet recently (within last 2 seconds)
    const lastProcess = lastProcessTime.current.get(tweetId)
    if (lastProcess && Date.now() - lastProcess < 2000) return false

    // Check if the tweet already has a valid banner
    const nextSibling = tweet.nextElementSibling
    if (nextSibling?.classList.contains('tweet-challenge-banner')) {
      const cachedData = tweetCache.current.get(tweetId)
      if (cachedData) {
        // If we have cached data and a banner, check its state
        const hasPaidBanner = nextSibling.querySelector('.text-green-500') !== null
        const hasGreyBanner = nextSibling.textContent?.includes('agent that does not exist') || false
        
        // If it's a grey banner and we have that cached, don't reprocess
        if (hasGreyBanner && cachedData.agentName && !cachedData.isPaid) return false
        
        // If it's a paid/unpaid banner matching our cache, don't reprocess
        if (!hasGreyBanner && hasPaidBanner === cachedData.isPaid) return false
      }
    }

    return true
  }

  // Function to force update a specific tweet's banner
  const updateTweetBanner = useCallback((tweetId: string) => {
    const tweetElement = document.querySelector(`a[href*="/${tweetId}"]`)?.closest(SELECTORS.TWEET)
    if (tweetElement instanceof HTMLElement) {
      // Clear the process time to force reprocessing
      lastProcessTime.current.delete(tweetId)
      processTweet(tweetElement)
    }
  }, [])

  // Function to check unpaid tweets for updates
  const checkUnpaidTweets = useCallback(async () => {
    debug.log('TweetObserver', 'Checking unpaid tweets', { count: unpaidTweets.current.size })
    for (const tweetId of unpaidTweets.current) {
      const cachedData = tweetCache.current.get(tweetId)
      if (!cachedData || cachedData.isPaid) {
        unpaidTweets.current.delete(tweetId)
        continue
      }

      updateTweetBanner(tweetId)
    }
  }, [updateTweetBanner])

  const processTweet = useCallback(
    async (tweet: HTMLElement) => {
      try {
        // Skip if not a full tweet (e.g. retweet preview)
        if (!tweet.querySelector(SELECTORS.TWEET_TIME)) return

        // Get tweet text and check if it's a challenge tweet
        const textElement = tweet.querySelector(SELECTORS.TWEET_TEXT)
        const text = textElement?.textContent || ''

        if (!text.includes(TWITTER_CONFIG.accountName)) return

        const agentName = extractAgentName(text)
        if (!agentName) return

        // Get tweet ID from time element href
        const timeElement = tweet.querySelector(SELECTORS.TWEET_TIME)
        const tweetUrl = timeElement?.closest('a')?.href
        const tweetId = tweetUrl?.split('/').pop()
        if (!tweetId) return

        // Check if we should process this tweet
        if (!shouldProcessTweet(tweet, tweetId)) return

        // Mark as processing and update last process time
        processingTweets.current.add(tweetId)
        lastProcessTime.current.set(tweetId, Date.now())

        // Remove existing banner if present
        const existingBanner = tweet.nextElementSibling
        if (existingBanner?.classList.contains('tweet-challenge-banner')) {
          existingBanner.remove()
        }

        // Get agent address
        const agentAddress = await getAgentAddressByName(agentName)

        if (!agentAddress) {
          // Agent doesn't exist - show grey banner
          tweet.style.border = '2px solid rgba(128, 128, 128, 0.1)'
          tweet.style.borderRadius = '0'

          const banner = document.createElement('div')
          banner.className = 'tweet-challenge-banner'
          banner.style.cssText = `
            padding: 12px 16px;
            background-color: rgba(128, 128, 128, 0.1);
            border-bottom: 1px solid rgb(128, 128, 128, 0.2);
            margin-top: 0;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 14px;
            color: rgb(128, 128, 128);
          `

          const bannerText = document.createElement('span')
          bannerText.textContent = 'This tweet references a Teeception agent that does not exist'
          banner.appendChild(bannerText)

          // Insert banner after the tweet
          tweet.parentNode?.insertBefore(banner, tweet.nextSibling)

          // Update cache for non-existent agent
          tweetCache.current.set(tweetId, {
            id: tweetId,
            isPaid: false,
            agentName: agentName // Store the non-existent agent name
          })
          setTweetCache(tweetCache.current)

          processingTweets.current.delete(tweetId)
          return
        }

        // Create contract instance
        const agentContract = new Contract(
          TEECEPTION_AGENT_ABI,
          agentAddress,
        )

        // Get all prompts for this tweet
        const prompts = await agentContract.get_user_tweet_prompts(
          account?.address ? `0x${BigInt(account.address).toString(16).padStart(64, '0')}` : '0x0',
          BigInt(tweetId),
          0,
          100 // Reasonable limit for attempts
        )

        // Check if we have a temporary paid state
        const tempPaidTweets = getTempPaidTweets()
        const isPaid = prompts && prompts.length > 0 || tempPaidTweets.has(tweetId)

        // Reset tweet border style
        tweet.style.border = isPaid ? 
          '2px solid rgba(0, 200, 83, 0.1)' : 
          '2px solid rgba(244, 33, 46, 0.1)'
        tweet.style.borderRadius = '0'

        const banner = document.createElement('div')
        banner.className = 'tweet-challenge-banner'

        if (isPaid) {
          // Paid tweet - show green banner with attempts dropdown
          banner.style.cssText = `
            padding: 12px 16px;
            background-color: rgba(0, 200, 83, 0.1);
            border-bottom: 1px solid rgb(0, 200, 83, 0.2);
            margin-top: 0;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 14px;
            color: rgb(0, 200, 83);
          `

          const bannerLeft = document.createElement('div')
          bannerLeft.className = 'flex items-center'
          bannerLeft.style.cssText = 'display: flex; align-items: center;'

          const bannerText = document.createElement('span')
          bannerText.textContent = 'Challenge attempts:'
          bannerLeft.appendChild(bannerText)
          
          // Add dropdown for attempts
          const attemptsList = createAttemptsList(prompts, tweetId)
          bannerLeft.appendChild(attemptsList)
          
          banner.appendChild(bannerLeft)

          const viewButton = document.createElement('button')
          viewButton.textContent = 'View Latest'
          viewButton.style.cssText = `
            background-color: rgb(0, 200, 83);
            color: white;
            padding: 6px 16px;
            border-radius: 9999px;
            font-weight: 500;
            font-size: 13px;
            cursor: pointer;
            border: none;
          `
          viewButton.addEventListener('click', () =>
            window.open(`https://teeception.ai/tweet/${tweetId}/prompt/${prompts[prompts.length - 1]}`, '_blank')
          )
          banner.appendChild(viewButton)
        } else {
          // Unpaid tweet - show red banner
          banner.style.cssText = `
            padding: 12px 16px;
            background-color: rgba(244, 33, 46, 0.1);
            border-bottom: 1px solid rgb(244, 33, 46, 0.2);
            margin-top: 0;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 14px;
            color: rgb(244, 33, 46);
          `

          const bannerText = document.createElement('span')
          bannerText.textContent = 'This tweet initiates a challenge'
          banner.appendChild(bannerText)

          const payButton = document.createElement('button')
          payButton.textContent = 'Pay to Challenge'
          payButton.style.cssText = `
            background-color: rgb(244, 33, 46);
            color: white;
            padding: 6px 16px;
            border-radius: 9999px;
            font-weight: 500;
            font-size: 13px;
            cursor: pointer;
            border: none;
          `
          payButton.addEventListener('click', () => onPayClick(tweetId, agentName))
          banner.appendChild(payButton)
        }

        // Insert banner after the tweet
        tweet.parentNode?.insertBefore(banner, tweet.nextSibling)

        // Update cache
        tweetCache.current.set(tweetId, {
          id: tweetId,
          isPaid,
          agentName,
        })
        setTweetCache(tweetCache.current)

        // Track unpaid tweets for rechecking
        if (!isPaid && agentAddress) {
          unpaidTweets.current.add(tweetId)
        } else {
          unpaidTweets.current.delete(tweetId)
        }

        // Double check the tweet is still in the DOM
        if (!document.contains(tweet)) {
          return
        }
      } catch (error) {
        debug.error('TweetObserver', 'Error processing tweet', error)
      } finally {
        const timeElement = tweet.querySelector(SELECTORS.TWEET_TIME)
        const tweetUrl = timeElement?.closest('a')?.href
        const currentTweetId = tweetUrl?.split('/').pop()
        if (currentTweetId) {
          processingTweets.current.delete(currentTweetId)
        }
      }
    },
    [currentUser, onPayClick, account]
  )

  const processExistingTweets = useCallback(() => {
    // Clear any pending process timeout
    if (processTimeoutRef.current) {
      clearTimeout(processTimeoutRef.current)
    }

    // Delay processing to let Twitter's UI settle
    processTimeoutRef.current = setTimeout(() => {
      const tweets = document.querySelectorAll(SELECTORS.TWEET)
      tweets.forEach((tweet) => {
        if (tweet instanceof HTMLElement) {
          processTweet(tweet)
        }
      })
    }, 500) // Increased delay to 500ms
  }, [processTweet])

  useEffect(() => {
    // Process existing tweets immediately on mount
    processExistingTweets()

    // Set up navigation listener
    const handleNavigation = () => {
      processExistingTweets()
    }

    // Handle both Twitter's client-side routing and browser navigation
    window.addEventListener('popstate', handleNavigation)
    window.addEventListener('pushstate', handleNavigation)
    window.addEventListener('replacestate', handleNavigation)

    // Also watch for scroll events as Twitter uses virtual scrolling
    let scrollTimeout: NodeJS.Timeout | null = null
    const handleScroll = () => {
      if (scrollTimeout) {
        clearTimeout(scrollTimeout)
      }
      scrollTimeout = setTimeout(() => {
        processExistingTweets()
        scrollTimeout = null
      }, 500) // Increased delay to 500ms
    }
    window.addEventListener('scroll', handleScroll, { passive: true })

    // Set up mutation observer with more specific targeting
    let mutationTimeout: NodeJS.Timeout | null = null
    observer.current = new MutationObserver((mutations) => {
      // Skip if we already have a pending update
      if (mutationTimeout) {
        clearTimeout(mutationTimeout)
      }

      mutationTimeout = setTimeout(() => {
        let shouldProcess = false
        for (const mutation of mutations) {
          if (mutation.type === 'childList') {
            const addedNodes = Array.from(mutation.addedNodes)
            const hasRelevantAddition = addedNodes.some((node) => {
              if (node instanceof HTMLElement) {
                return (
                  node.matches(SELECTORS.TWEET) ||
                  node.matches('[data-testid="tweet"]') ||
                  node.matches('[data-testid="tweetText"]')
                )
              }
              return false
            })
            if (hasRelevantAddition) {
              shouldProcess = true
              break
            }
          }
        }

        if (shouldProcess) {
          processExistingTweets()
        }
        mutationTimeout = null
      }, 500) // Increased delay to 500ms
    })

    observer.current.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-testid'],
    })

    // Reduce the frequency of the periodic check
    const checkInterval = setInterval(processExistingTweets, 5000) // Increased to 5 seconds

    // Add periodic check for unpaid tweets
    const unpaidCheckInterval = setInterval(checkUnpaidTweets, 10000) // Check every 10 seconds

    return () => {
      if (processTimeoutRef.current) {
        clearTimeout(processTimeoutRef.current)
      }
      if (scrollTimeout) {
        clearTimeout(scrollTimeout)
      }
      if (mutationTimeout) {
        clearTimeout(mutationTimeout)
      }
      if (checkInterval) {
        clearInterval(checkInterval)
      }
      if (unpaidCheckInterval) {
        clearInterval(unpaidCheckInterval)
      }
      window.removeEventListener('popstate', handleNavigation)
      window.removeEventListener('pushstate', handleNavigation)
      window.removeEventListener('replacestate', handleNavigation)
      window.removeEventListener('scroll', handleScroll)
      observer.current?.disconnect()
    }
  }, [processExistingTweets, checkUnpaidTweets])

  // Return both functions
  return {
    updateBanner: updateTweetBanner,
    checkUnpaidTweets,
    markTweetAsPaid
  }
}
