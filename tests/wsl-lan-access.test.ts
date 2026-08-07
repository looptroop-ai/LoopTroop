import { describe, expect, it } from 'vitest'
import { DEFAULT_DEV_BIND_HOST, type ResolvedDevHostMode } from '../scripts/dev-host-mode'
import { buildWslLanAccessPlan, isWslRuntime } from '../scripts/wsl-lan-access'

const enabledWildcardHostMode: ResolvedDevHostMode = {
  enabled: true,
  bindHost: DEFAULT_DEV_BIND_HOST,
  requestedValue: 'true',
  source: 'npm-config',
}

describe('isWslRuntime', () => {
  it('detects WSL from environment or proc version', () => {
    expect(isWslRuntime({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, procVersion: null })).toBe(true)
    expect(isWslRuntime({ platform: 'linux', env: {}, procVersion: 'Linux version 6.6.87.2-microsoft-standard-WSL2' })).toBe(true)
    expect(isWslRuntime({ platform: 'linux', env: {}, procVersion: 'Linux version 6.6.87-generic' })).toBe(false)
    expect(isWslRuntime({ platform: 'darwin', env: { WSL_DISTRO_NAME: 'Ubuntu' }, procVersion: null })).toBe(false)
  })
})

describe('buildWslLanAccessPlan', () => {
  it('builds Windows LAN URLs and explicit portproxy guidance for WSL wildcard LAN sharing', () => {
    const plan = buildWslLanAccessPlan({
      hostMode: enabledWildcardHostMode,
      frontendPort: 5173,
      isWsl: true,
      wslAddresses: ['172.25.190.136'],
      windowsAddresses: ['192.168.1.40', '10.0.0.4'],
    })

    expect(plan.enabled).toBe(true)
    expect(plan.wslTargetAddress).toBe('172.25.190.136')
    expect(plan.frontendUrls).toEqual([
      'http://192.168.1.40:5173',
      'http://10.0.0.4:5173',
    ])
    expect(plan.setupCommands).toHaveLength(1)
    const setupCommand = plan.setupCommands[0] ?? ''
    expect(setupCommand).toContain('Set-Service iphlpsvc -StartupType Automatic')
    expect(setupCommand).toContain('Start-Service iphlpsvc')
    expect(setupCommand).toContain("$ips=@('192.168.1.40','10.0.0.4')")
    expect(setupCommand).toContain('$ports=@(5173)')
    expect(setupCommand).toContain('LoopTroop Dev LAN profile check')
    expect(setupCommand).toContain('NetworkCategory -ne \'Private\'')
    expect(setupCommand).toContain('Set-NetConnectionProfile -InterfaceIndex $($_.InterfaceIndex) -NetworkCategory Private')
    expect(setupCommand).toContain('Settings > Network & internet > Wi-Fi/Ethernet > your connected network > Network profile type > Private')
    expect(setupCommand).toContain('netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0')
    expect(setupCommand).toContain('netsh interface portproxy add v4tov4 listenaddress=$ip listenport=$port connectaddress=127.0.0.1 connectport=$port')
    expect(setupCommand).toContain('New-NetFirewallRule -DisplayName "LoopTroop Dev LAN" -Direction Inbound -Action Allow -Protocol TCP -LocalAddress $ips -LocalPort $ports -Profile Private')
    expect(setupCommand).toContain('LoopTroop Dev LAN self-test OK')
    expect(setupCommand).toContain('router/AP client isolation')
    expect(plan.cleanupCommands).toEqual([
      "$ips=@('192.168.1.40','10.0.0.4'); " +
      '$ports=@(5173); ' +
      'foreach ($port in $ports) { netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=$port 2>$null | Out-Null }; ' +
      'foreach ($ip in $ips) { foreach ($port in $ports) { netsh interface portproxy delete v4tov4 listenaddress=$ip listenport=$port 2>$null | Out-Null } }; ' +
      'Remove-NetFirewallRule -DisplayName "LoopTroop Dev LAN" -ErrorAction SilentlyContinue',
    ])
  })

  it('builds WSL guidance even when only the Windows LAN address is detected', () => {
    const plan = buildWslLanAccessPlan({
      hostMode: enabledWildcardHostMode,
      frontendPort: 5173,
      isWsl: true,
      wslAddresses: [],
      windowsAddresses: ['192.168.1.40'],
    })

    expect(plan.enabled).toBe(true)
    expect(plan.wslTargetAddress).toBeUndefined()
    expect(plan.frontendUrls).toEqual(['http://192.168.1.40:5173'])
    expect(plan.setupCommands[0]).toContain("$ips=@('192.168.1.40')")
    expect(plan.setupCommands[0]).toContain('listenaddress=$ip')
    expect(plan.setupCommands[0]).toContain('connectaddress=127.0.0.1')
  })

  it('does not apply outside WSL or when explicit host binding is already configured', () => {
    expect(buildWslLanAccessPlan({
      hostMode: enabledWildcardHostMode,
      frontendPort: 5173,
      isWsl: false,
      wslAddresses: ['172.25.190.136'],
      windowsAddresses: ['192.168.1.40'],
    })).toMatchObject({ enabled: false, reason: 'Runtime is not WSL.' })

    expect(buildWslLanAccessPlan({
      hostMode: { enabled: true, bindHost: '192.168.1.40', requestedValue: '192.168.1.40', source: 'env' },
      frontendPort: 5173,
      isWsl: true,
      wslAddresses: ['172.25.190.136'],
      windowsAddresses: ['192.168.1.40'],
    })).toMatchObject({ enabled: false, reason: 'Explicit host binding is already configured.' })
  })

  it('does not advertise WSL NAT addresses as directly reachable LAN URLs', () => {
    expect(buildWslLanAccessPlan({
      hostMode: enabledWildcardHostMode,
      frontendPort: 5173,
      isWsl: true,
      wslAddresses: ['172.25.190.136'],
      windowsAddresses: [],
    })).toMatchObject({
      enabled: false,
      reason: 'No Windows LAN address was detected.',
      frontendUrls: [],
    })
  })
})
