import type { CommandSpec } from '@shared/commandSpec'
import { Button } from '@/components/ui/button'

export function CommandSpecListEditor({
  commands,
  disabled,
  label = 'Command',
  onChange,
}: {
  commands: CommandSpec[]
  disabled?: boolean
  label?: string
  onChange: (commands: CommandSpec[]) => void
}) {
  const update = (index: number, command: CommandSpec) => {
    onChange(commands.map((current, currentIndex) => currentIndex === index ? command : current))
  }

  return (
    <div className="space-y-2">
      {commands.map((command, index) => {
        const itemLabel = `${label} ${index + 1}`
        return (
          <div key={index} className="rounded-md border border-input p-2 space-y-2">
            <div className="flex gap-2">
              <select
                value={command.mode}
                disabled={disabled}
                aria-label={`${itemLabel} mode`}
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
                  aria-label={`${itemLabel} shell`}
                  className="rounded-md border border-input bg-background px-2 py-1 text-xs"
                  onChange={(event) => update(index, { ...command, shell: event.target.value as 'posix' | 'cmd' | 'powershell' })}
                >
                  <option value="posix">POSIX</option>
                  <option value="powershell">PowerShell</option>
                  <option value="cmd">CMD</option>
                </select>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                aria-label={`Remove ${itemLabel}`}
                onClick={() => onChange(commands.filter((_, i) => i !== index))}
              >
                ×
              </Button>
            </div>
            {command.mode === 'shell' ? (
              <textarea
                aria-label={`${itemLabel} script`}
                value={command.script}
                disabled={disabled}
                rows={2}
                className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
                onChange={(event) => update(index, { ...command, script: event.target.value })}
              />
            ) : (
              <>
                <input
                  aria-label={`${itemLabel} program`}
                  value={command.program}
                  disabled={disabled}
                  placeholder="Program"
                  className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
                  onChange={(event) => update(index, { ...command, program: event.target.value })}
                />
                <div role="group" aria-label={`${itemLabel} arguments`} className="space-y-1">
                  {command.args.map((argument, argumentIndex) => (
                    <div key={argumentIndex} className="flex gap-1">
                      <textarea
                        aria-label={`${itemLabel} argument ${argumentIndex + 1}`}
                        value={argument}
                        disabled={disabled}
                        rows={1}
                        placeholder={`Argument ${argumentIndex + 1}`}
                        className="flex-1 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs"
                        onChange={(event) => {
                          const args = [...command.args]
                          args[argumentIndex] = event.target.value
                          update(index, { ...command, args })
                        }}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={disabled}
                        aria-label={`Remove ${itemLabel} argument ${argumentIndex + 1}`}
                        onClick={() => update(index, { ...command, args: command.args.filter((_, currentIndex) => currentIndex !== argumentIndex) })}
                      >
                        ×
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    aria-label={`Add ${itemLabel} argument`}
                    onClick={() => update(index, { ...command, args: [...command.args, ''] })}
                  >
                    + Add argument
                  </Button>
                </div>
              </>
            )}
            <input
              aria-label={`${itemLabel} working directory`}
              value={command.cwd}
              disabled={disabled}
              placeholder="Repository-relative working directory"
              className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
              onChange={(event) => update(index, { ...command, cwd: event.target.value })}
            />
          </div>
        )
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        aria-label={`Add ${label.toLowerCase()}`}
        onClick={() => onChange([...commands, { mode: 'process', program: '', args: [], cwd: '.', env: {} }])}
      >
        + Add command
      </Button>
    </div>
  )
}
