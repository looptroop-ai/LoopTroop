import type { CommandSpec } from '@shared/commandSpec'
import { Button } from '@/components/ui/button'

export function CommandSpecListEditor({
  commands,
  disabled,
  onChange,
}: {
  commands: CommandSpec[]
  disabled?: boolean
  onChange: (commands: CommandSpec[]) => void
}) {
  const update = (index: number, command: CommandSpec) => {
    onChange(commands.map((current, currentIndex) => currentIndex === index ? command : current))
  }
  return (
    <div className="space-y-2">
      {commands.map((command, index) => (
        <div key={index} className="rounded-md border border-input p-2 space-y-2">
          <div className="flex gap-2">
            <select
              value={command.mode}
              disabled={disabled}
              className="rounded-md border border-input bg-background px-2 py-1 text-xs"
              onChange={(event) => update(index, event.target.value === 'process'
                ? { mode: 'process', program: '', args: [], cwd: command.cwd, env: command.env }
                : { mode: 'shell', shell: 'posix', script: '', cwd: command.cwd, env: command.env })}
            >
              <option value="process">Direct process</option>
              <option value="shell">Shell script</option>
            </select>
            {command.mode === 'shell' && (
              <select
                value={command.shell}
                disabled={disabled}
                className="rounded-md border border-input bg-background px-2 py-1 text-xs"
                onChange={(event) => update(index, { ...command, shell: event.target.value as 'posix' | 'cmd' | 'powershell' })}
              >
                <option value="posix">POSIX</option>
                <option value="powershell">PowerShell</option>
                <option value="cmd">CMD</option>
              </select>
            )}
            <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onChange(commands.filter((_, i) => i !== index))}>×</Button>
          </div>
          {command.mode === 'shell' ? (
            <textarea value={command.script} disabled={disabled} rows={2} className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs" onChange={(event) => update(index, { ...command, script: event.target.value })} />
          ) : (
            <>
              <input value={command.program} disabled={disabled} placeholder="Program" className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs" onChange={(event) => update(index, { ...command, program: event.target.value })} />
              <textarea value={JSON.stringify(command.args)} disabled={disabled} rows={2} placeholder='Arguments, e.g. ["test"]' className="w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-xs" onChange={(event) => {
                try {
                  const args = JSON.parse(event.target.value) as unknown
                  if (Array.isArray(args) && args.every((arg) => typeof arg === 'string')) update(index, { ...command, args })
                } catch { /* keep the last valid arguments while editing */ }
              }} />
            </>
          )}
          <input value={command.cwd} disabled={disabled} placeholder="Repository-relative working directory" className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs" onChange={(event) => update(index, { ...command, cwd: event.target.value })} />
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onChange([...commands, { mode: 'process', program: '', args: [], cwd: '.', env: {} }])}>+ Add command</Button>
    </div>
  )
}
