interface ConnectionStatus {
  dotClass: string
  label: string
}

const connectedModelStatus = (models: readonly unknown[] | undefined, isBusy: boolean, hasError: boolean): ConnectionStatus => {
  if (isBusy) return { dotClass: 'bg-amber-500', label: 'OpenCode connected, checking models…' }
  if (hasError) return { dotClass: 'bg-amber-500', label: 'OpenCode connected, but model discovery failed' }
  if (!models?.length) return { dotClass: 'bg-amber-500', label: 'OpenCode connected, but no models are available' }
  return { dotClass: 'bg-green-500', label: 'OpenCode connected and working' }
}

export const getOpenCodeStatus = (connected: boolean | null, models: readonly unknown[] | undefined, isBusy: boolean, hasError: boolean): ConnectionStatus | null => {
  if (connected === null) return null
  if (!connected) return { dotClass: 'bg-red-500', label: 'OpenCode not connected' }
  return connectedModelStatus(models, isBusy, hasError)
}

export const getOpenCodeSignInAdvice = (advice: unknown): string | null => {
  if (typeof advice !== 'string') return null
  return advice.trim() ? advice : null
}
