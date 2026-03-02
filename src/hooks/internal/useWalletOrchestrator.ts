import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getWalletIdFromLoadingState,
  getWalletStore,
  isWalletErrorState,
  isWalletLoadingState,
  updateWalletLoadingState,
  type WalletStore,
} from '../../store/walletStore'
import { useWalletManager } from '../useWalletManager'
import {
  getCombinedStatus,
  getWorkletStatus,
  isAppInProgressStatus,
  isAppReadyStatus,
} from '../../utils/initializationState'
import {
  getWalletSwitchDecision,
  shouldHandleError,
  shouldMarkWalletAsReady,
  shouldResetToNotLoaded,
} from '../../utils/walletStateHelpers'
import { log, logError } from '../../utils/logger'

// Custom deep equality for walletLoadingState comparison
const deepEqualityFn = (a: any, b: any) => {
  if (a === b) return true
  if (!a || !b) return false
  if (typeof a !== 'object' || typeof b !== 'object') return a === b

  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false

  for (const key of keysA) {
    if (!keysB.includes(key)) return false
    if (a[key] !== b[key]) return false
  }
  return true
}

export interface UseWalletOrchestratorProps {
  enableAutoInitialization: boolean
  currentUserId?: string | null
  isWorkletStarted: boolean
  isWorkletInitialized: boolean
  workletError: string | null
  isWorkletLoading: boolean
}

/**
 * The "brain" for all wallet-related state management and operations.
 * This hook encapsulates the complex logic for initializing, switching,
 * and synchronizing wallet state.
 */
export function useWalletOrchestrator({
  enableAutoInitialization,
  currentUserId,
  isWorkletStarted,
  isWorkletInitialized,
  workletError,
  isWorkletLoading,
}: UseWalletOrchestratorProps) {
  // Wallet state - read from walletStore (single source of truth)
  const walletStore = getWalletStore()

  // Subscribe to primitive values directly
  const activeWalletId = walletStore(
    (state: WalletStore) => state.activeWalletId,
  )

  // For walletLoadingState, use a ref to manually check equality and prevent unnecessary re-renders
  const walletLoadingStateRef = useRef(
    walletStore.getState().walletLoadingState,
  )
  const [walletLoadingState, setWalletLoadingState] = useState(
    walletStore.getState().walletLoadingState,
  )

  useEffect(() => {
    const unsubscribe = walletStore.subscribe((state: WalletStore) => {
      const newState = state.walletLoadingState
      // Only update if content actually changed (deep equality check)
      if (!deepEqualityFn(walletLoadingStateRef.current, newState)) {
        walletLoadingStateRef.current = newState
        setWalletLoadingState(newState)
      }
    })
    return unsubscribe
  }, [walletStore])

  const walletAddresses = walletStore((state: WalletStore) =>
    state.activeWalletId ? state.addresses[state.activeWalletId] : undefined,
  )

  // Hooks for wallet operations
  const {
    initializeWallet,
    hasWallet,
    error: walletManagerError,
  } = useWalletManager()

  // Store initializeWallet in a ref to avoid it being a dependency of the effect
  // This breaks the infinite loop: effect runs → component re-renders → initializeWallet recreated → effect runs again
  const initializeWalletRef = useRef(initializeWallet)
  useEffect(() => {
    initializeWalletRef.current = initializeWallet
  }, [initializeWallet])

  // Track authentication errors to prevent infinite retry loops
  // When biometric authentication fails, we shouldn't automatically retry
  const authErrorRef = useRef<string | null>(null)

  // Derive isWalletInitializing from walletLoadingState (single source of truth)
  const isWalletInitializing = useMemo(() => {
    return isWalletLoadingState(walletLoadingState)
  }, [walletLoadingState])

  // Consolidated effect: Sync wallet loading state with activeWalletId, addresses, and errors
  useEffect(() => {
    // EARLY EXIT: Skip automatic wallet initialization if disabled (e.g., when logged out)
    if (!enableAutoInitialization) {
      // Clear authentication error flag when auto-init is disabled (e.g., logout)
      if (authErrorRef.current) {
        log(
          '[useWalletOrchestrator] Clearing authentication error flag - auto-init disabled',
        )
        authErrorRef.current = null
      }
      return
    }

    // VALIDATION 1: User identity must be confirmed before auto-initialization
    if (currentUserId === undefined || currentUserId === null) {
      log(
        '[useWalletOrchestrator] Waiting for user identity confirmation before auto-init',
        {
          hasActiveWalletId: !!activeWalletId,
        },
      )
      return
    }

    // VALIDATION 2: If activeWalletId doesn't match currentUserId, set it to correct user
    if (activeWalletId !== currentUserId) {
      log('[useWalletOrchestrator] Setting activeWalletId to current user', {
        activeWalletId,
        currentUserId,
      })

      walletStore.setState({
        activeWalletId: currentUserId,
      })

      if (authErrorRef.current) {
        authErrorRef.current = null
      }

      return
    }

    // EARLY EXIT: Skip if we have an authentication error to prevent infinite retry loop
    if (authErrorRef.current) {
      log(
        '[useWalletOrchestrator] Skipping auto-initialization due to authentication error',
        {
          error: authErrorRef.current,
        },
      )
      return
    }

    const currentWalletId = getWalletIdFromLoadingState(walletLoadingState)
    const hasAddresses = !!(
      walletAddresses && Object.keys(walletAddresses).length > 0
    )

    // Handle activeWalletId cleared
    if (shouldResetToNotLoaded(activeWalletId, walletLoadingState)) {
      log(
        '[useWalletOrchestrator] Active wallet cleared, resetting wallet state',
      )
      if (authErrorRef.current) {
        log(
          '[useWalletOrchestrator] Clearing authentication error flag on wallet reset',
        )
        authErrorRef.current = null
      }
      walletStore.setState((prev) =>
        updateWalletLoadingState(prev, { type: 'not_loaded' }),
      )
      return
    }

    if (!activeWalletId) {
      return
    }

    // Handle wallet switching
    const switchDecision = getWalletSwitchDecision(
      currentWalletId,
      activeWalletId,
      hasAddresses,
    )
    if (switchDecision.shouldSwitch) {
      log('[useWalletOrchestrator] Active wallet changed', {
        from: currentWalletId,
        to: activeWalletId,
        hasAddresses,
        isWorkletStarted,
        shouldMarkReady: switchDecision.shouldMarkReady,
      })

      if (isWorkletStarted) {
        if (isWalletInitializing) {
          log(
            '[useWalletOrchestrator] Skipping wallet switch initialization - already in progress',
            {
              activeWalletId,
              walletLoadingState: walletLoadingState.type,
            },
          )
          return
        }

        log(
          '[useWalletOrchestrator] Wallet switch detected - triggering initialization',
          {
            activeWalletId,
            hasAddresses,
          },
        )

        ;(async () => {
          try {
            const walletExists = await hasWallet(activeWalletId)
            const shouldCreateNew = !walletExists

            log('[useWalletOrchestrator] Wallet existence check', {
              activeWalletId,
              walletExists,
              shouldCreateNew,
            })

            await initializeWalletRef.current({
              createNew: shouldCreateNew,
              walletId: activeWalletId,
            })
            log(
              '[useWalletOrchestrator] Wallet initialized successfully after switch',
            )
          } catch (error) {
            logError(
              '[useWalletOrchestrator] Failed to initialize wallet after switch:',
              error,
            )
          }
        })()
      } else {
        walletStore.setState((prev) =>
          updateWalletLoadingState(prev, {
            type: 'not_loaded',
          }),
        )
      }
      return
    }

    // Handle cached wallet on restart
    if (
      walletLoadingState.type === 'not_loaded' &&
      hasAddresses &&
      activeWalletId &&
      isWorkletStarted
    ) {
      if (isWalletInitializing) {
        log(
          '[useWalletOrchestrator] Skipping cached wallet initialization - already in progress',
          {
            activeWalletId,
            walletLoadingState: walletLoadingState.type,
          },
        )
        return
      }

      log(
        '[useWalletOrchestrator] Cached wallet detected on restart - triggering initialization',
        {
          activeWalletId,
          hasAddresses,
          isWorkletStarted,
          isWorkletInitialized,
          walletLoadingState: walletLoadingState.type,
        },
      )

      ;(async () => {
        try {
          const walletExists = await hasWallet(activeWalletId)
          const shouldCreateNew = !walletExists

          log('[useWalletOrchestrator] Wallet existence check', {
            activeWalletId,
            walletExists,
            shouldCreateNew,
          })

          await initializeWalletRef.current({
            createNew: shouldCreateNew,
            walletId: activeWalletId,
          })
          log(
            '[useWalletOrchestrator] Wallet initialized successfully from cache',
          )
        } catch (error) {
          logError(
            '[useWalletOrchestrator] Failed to initialize wallet from cache:',
            error,
          )
        }
      })()

      return
    }

    // Handle new wallet initialization
    if (
      walletLoadingState.type === 'not_loaded' &&
      !hasAddresses &&
      activeWalletId &&
      isWorkletStarted
    ) {
      if (isWalletInitializing) {
        log(
          '[useWalletOrchestrator] Skipping wallet initialization - already in progress',
          {
            activeWalletId,
            walletLoadingState: walletLoadingState.type,
          },
        )
        return
      }

      log(
        '[useWalletOrchestrator] Active wallet detected without addresses - triggering initialization',
        {
          activeWalletId,
          hasAddresses,
          isWorkletStarted,
          walletLoadingState: walletLoadingState.type,
        },
      )

      ;(async () => {
        try {
          const walletExists = await hasWallet(activeWalletId)
          const shouldCreateNew = !walletExists

          log('[useWalletOrchestrator] Wallet existence check', {
            activeWalletId,
            walletExists,
            shouldCreateNew,
          })

          await initializeWalletRef.current({
            createNew: shouldCreateNew,
            walletId: activeWalletId,
          })
          log('[useWalletOrchestrator] Wallet initialized successfully')
        } catch (error) {
          logError('[useWalletOrchestrator] Failed to initialize wallet:', error)
        }
      })()

      return
    }

    // Handle ready state transitions
    if (
      shouldMarkWalletAsReady(
        walletLoadingState,
        hasAddresses,
        currentWalletId,
        activeWalletId,
        isWorkletInitialized,
      )
    ) {
      log('[useWalletOrchestrator] Wallet ready', { activeWalletId })
      walletStore.setState((prev) =>
        updateWalletLoadingState(prev, {
          type: 'ready',
          identifier: activeWalletId,
        }),
      )
      return
    }

    // Handle errors from useWalletManager
    if (
      shouldHandleError(
        walletManagerError,
        currentWalletId,
        activeWalletId,
        walletLoadingState,
      )
    ) {
      log('[useWalletOrchestrator] Wallet operation error detected', {
        activeWalletId,
        error: walletManagerError,
      })
      const error = new Error(walletManagerError!)

      const errorMessage = walletManagerError?.toLowerCase() || ''
      const isAuthError =
        errorMessage.includes('authentication') ||
        errorMessage.includes('biometric') ||
        errorMessage.includes('user cancel')

      if (isAuthError && !authErrorRef.current) {
        log(
          '[useWalletOrchestrator] Authentication error detected - preventing auto-retry',
          {
            error: walletManagerError,
          },
        )
        authErrorRef.current = walletManagerError || 'Authentication failed'
      }

      walletStore.setState((prev) =>
        updateWalletLoadingState(prev, {
          type: 'error',
          identifier: activeWalletId,
          error,
        }),
      )
    }
  }, [
    enableAutoInitialization,
    currentUserId,
    activeWalletId,
    walletLoadingState,
    walletAddresses,
    walletManagerError,
    isWalletInitializing,
    isWorkletStarted,
    isWorkletInitialized,
    hasWallet,
  ])

  // Retry initialization
  const retry = useCallback(() => {
    log('[useWalletOrchestrator] Retrying initialization...')
    if (authErrorRef.current) {
      log(
        '[useWalletOrchestrator] Clearing authentication error flag for retry',
      )
      authErrorRef.current = null
    }
    if (isWalletErrorState(walletLoadingState)) {
      walletStore.setState((prev) =>
        updateWalletLoadingState(prev, { type: 'not_loaded' }),
      )
    }
  }, [walletLoadingState, walletStore])

  // =================================================================
  // Derived State
  // =================================================================

  const walletStateObject = useMemo(
    () => ({
      status: walletLoadingState.type,
      identifier: getWalletIdFromLoadingState(walletLoadingState),
      error:
        walletLoadingState.type === 'error' ? walletLoadingState.error : null,
    }),
    [walletLoadingState],
  )

  const workletStatus = useMemo(() => {
    return getWorkletStatus({
      isWorkletStarted,
      isLoading: isWorkletLoading,
      error: workletError,
    })
  }, [isWorkletStarted, isWorkletLoading, workletError])

  const status = useMemo(() => {
    return getCombinedStatus(
      {
        isWorkletStarted,
        isLoading: isWorkletLoading,
        error: workletError,
      },
      walletLoadingState,
    )
  }, [isWorkletStarted, isWorkletLoading, workletError, walletLoadingState])

  const isInitializing = useMemo(() => isAppInProgressStatus(status), [status])
  const isReady = useMemo(() => isAppReadyStatus(status), [status])

  const walletError =
    walletLoadingState.type === 'error' ? walletLoadingState.error : null
  const initializationError = workletError
    ? new Error(workletError)
    : walletError

  const walletExists = useMemo(() => {
    if (walletLoadingState.type === 'loading') {
      return walletLoadingState.walletExists
    }
    if (walletLoadingState.type === 'ready') {
      return true
    }
    return null
  }, [walletLoadingState])

  const loadingWalletId = useMemo(() => {
    if (
      walletLoadingState.type === 'checking' ||
      walletLoadingState.type === 'loading'
    ) {
      return walletLoadingState.identifier
    }
    return null
  }, [walletLoadingState])

  return {
    status,
    workletStatus,
    walletState: walletStateObject,
    isInitializing,
    isReady,
    activeWalletId,
    loadingWalletId,
    walletExists,
    error: initializationError,
    retry,
  }
}
