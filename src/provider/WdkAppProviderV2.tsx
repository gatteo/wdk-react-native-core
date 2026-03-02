import React, { createContext, useMemo, useRef, useEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createSecureStorage } from '@tetherto/wdk-react-native-secure-storage'

import { useAppLifecycle } from '../hooks/internal/useAppLifecycle'
import { useWalletOrchestrator } from '../hooks/internal/useWalletOrchestrator'
import { useWorkletInitializer } from '../hooks/internal/useWorkletInitializer'

import { WalletSetupService } from '../services/walletSetupService'
import { normalizeError } from '../utils/errorUtils'
import { logError } from '../utils/logger'
import { validateWdkConfigs } from '../utils/validation'
import {
  DEFAULT_QUERY_GC_TIME_MS,
  DEFAULT_QUERY_STALE_TIME_MS,
} from '../utils/constants'
import type { AppStatus, InitializationStatus } from '../utils/initializationState'
import type { WdkConfigs, BundleConfig } from '../types'

export interface WdkAppContextValue {
  status: AppStatus
  workletStatus: InitializationStatus
  workletState: {
    isReady: boolean
    isLoading: boolean
    error: string | null
  }
  walletState: {
    status: 'not_loaded' | 'checking' | 'loading' | 'ready' | 'error'
    identifier: string | null
    error: Error | null
  }
  isInitializing: boolean
  isReady: boolean
  activeWalletId: string | null
  loadingWalletId: string | null
  walletExists: boolean | null
  error: Error | null
  retry: () => void
}

const WdkAppContext = createContext<WdkAppContextValue | null>(null)

export interface WdkAppProviderProps<
  TNetwork extends Record<string, unknown> = Record<string, unknown>,
  TProtocol extends Record<string, unknown> = Record<string, unknown>,
> {
  bundle: BundleConfig
  wdkConfigs: WdkConfigs<TNetwork, TProtocol>
  enableAutoInitialization?: boolean
  requireBiometrics?: boolean
  currentUserId?: string | null
  clearSensitiveDataOnBackground?: boolean
  children: React.ReactNode
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: DEFAULT_QUERY_STALE_TIME_MS,
      gcTime: DEFAULT_QUERY_GC_TIME_MS,
    },
  },
})

export function WdkAppProvider<
  TNetwork extends Record<string, unknown> = Record<string, unknown>,
  TProtocol extends Record<string, unknown> = Record<string, unknown>,
>({
  bundle: bundleConfig,
  wdkConfigs,
  enableAutoInitialization = true,
  requireBiometrics = true,
  currentUserId,
  clearSensitiveDataOnBackground = false,
  children,
}: WdkAppProviderProps<TNetwork, TProtocol>) {
  // Synchronous service setup (must run before child effects)
  const secureStorageInitialized = useRef(false)
  const secureStorage = useMemo(() => createSecureStorage(), [])

  if (!secureStorageInitialized.current) {
    WalletSetupService.setSecureStorage(secureStorage)
    secureStorageInitialized.current = true
  }

  useEffect(() => {
    try {
      validateWdkConfigs(wdkConfigs)
    } catch (error) {
      const err = normalizeError(error, true, {
        component: 'WdkAppProvider',
        operation: 'propsValidation',
      })
      logError('[WdkAppProvider] Invalid props:', err)
      throw err
    }
  }, [wdkConfigs])

  const {
    isWorkletStarted,
    isInitialized: isWorkletInitialized,
    isLoading: isWorkletLoading,
    error: workletError,
  } = useWorkletInitializer({
    bundleConfig,
    wdkConfigs,
    requireBiometrics,
  })

  useAppLifecycle({ clearSensitiveDataOnBackground })

  const orchestratorState = useWalletOrchestrator({
    enableAutoInitialization,
    currentUserId,
    isWorkletStarted,
    isWorkletInitialized,
    workletError,
    isWorkletLoading,
  })

  const workletState = useMemo(
    () => ({
      isReady: isWorkletStarted && !isWorkletLoading && !workletError,
      isLoading: isWorkletLoading,
      error: workletError,
    }),
    [isWorkletStarted, isWorkletLoading, workletError],
  )

  const contextValue: WdkAppContextValue = useMemo(
    () => ({
      ...orchestratorState,
      workletState,
    }),
    [orchestratorState, workletState],
  )

  return (
    <QueryClientProvider client={queryClient}>
      <WdkAppContext.Provider value={contextValue}>
        {children}
      </WdkAppContext.Provider>
    </QueryClientProvider>
  )
}

export { WdkAppContext }
