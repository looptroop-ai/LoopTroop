import { QueryClient } from '@tanstack/react-query'
import { QUERY_STALE_TIME_5S } from './constants'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: QUERY_STALE_TIME_5S,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})
