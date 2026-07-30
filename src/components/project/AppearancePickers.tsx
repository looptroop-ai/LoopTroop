import { useState, useRef } from 'react'
import { Search, X, Upload } from 'lucide-react'
import { cn } from '@/lib/utils'
import { emojiMatchesSearch } from '@/lib/emojiNames'
import { DropdownPicker } from '@/components/shared/DropdownPicker'
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

const FAVORITE_EMOJIS = ['😀', '📁', '🔧', '🎨', '🐱', '❤️', '✈️', '🎮', '🌲', '🔥']

const EMOJI_CATEGORIES = [
  { name: 'Smileys', emojis: ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙', '🥲', '😋', '😛', '😜', '🤪', '😝', '🤗', '🤭', '🫢', '🫣', '🤫', '🤔'] },
  { name: 'Animals', emojis: ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🙈', '🙉', '🙊', '🐔', '🐧', '🐦', '🐤', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗', '🦄', '🐝', '🐕', '🐈', '🐙', '🦋', '🐳'] },
  { name: 'Food & Drink', emojis: ['🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍈', '🍒', '🍑', '🥭', '🍍', '🥝', '🍅', '🥑', '🍆', '🌽', '🥕', '🧄', '🧅', '🥔', '🍠', '🌶️', '🥒', '🥬', '🥦', '🧈', '🍕', '☕', '🍔', '🎂', '🍿', '🥤', '🍩', '🧁', '🌮'] },
  { name: 'Nature', emojis: ['🌸', '🌺', '🌻', '🌹', '🌷', '🌼', '🌵', '🌲', '🌳', '🌴', '🍀', '🍁', '🍂', '🍃', '🌾', '🌱', '🪴', '🎍', '🪸', '🍄', '🪨', '🌍', '🌎', '🌏', '🌕', '🌙', '⭐', '🌟', '💫', '✨', '🌊', '🔥', '🌿', '🌈', '☀️'] },
  { name: 'Objects', emojis: ['📦', '💻', '🖥️', '⌨️', '🖱️', '⚙️', '🔧', '🛠️', '🔌', '📡', '🔬', '🧪', '🔭', '📱', '💾', '💿', '📀', '🎥', '📷', '📸', '🔑', '🔒', '🗝️', '🧰', '📐', '📎', '🖊️', '✏️', '🔗', '📌', '📁', '📂', '📋', '📝', '📄', '📑', '🗂️', '💼', '🎒'] },
  { name: 'Tech & Science', emojis: ['🔩', '🔨', '📊', '📈', '📉', '🧮', '🧬', '🔎', '🔍', '💡', '⚡', '📧', '✉️', '📮', '📯', '💬', '💭', '📢', '📣', '🛰️'] },
  { name: 'Transport', emojis: ['🚀', '✈️', '🚁', '🚂', '🚗', '🛸', '⛵', '🏎️', '🚧'] },
  { name: 'Symbols', emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❤️‍🔥', '💯', '✅', '❌', '⭕', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '⚫', '⬜', '🔶', '🔷', '🔺', '🔻', '💠', '🏁', '💎', '🏆', '🎖️', '🏅', '👑', '💰', '💳'] },
  { name: 'Activities', emojis: ['⚽', '🏀', '🏈', '⚾', '🎾', '🏐', '🏉', '🎱', '🏓', '🏸', '🥅', '🏒', '🏑', '🥊', '🎮', '🎯', '🎳', '🎸', '🎹', '🎺', '🎻', '🪘', '🎨', '🎬', '🎤', '🎧', '📚', '🎭', '🃏', '♟️', '🏋️', '🧗', '🏄', '🎲', '🎵'] },
  { name: 'Health', emojis: ['🏥', '💊', '🩺', '🩹', '❤️‍🩹', '🧠', '👁️', '💉', '🦷', '🫀'] },
]

export interface EmojiPickerSectionProps {
  icon: string
  onIconChange: (icon: string) => void
  isIconPickerOpen: boolean
  onIconOpenChange: (open: boolean) => void
}

export function EmojiPickerSection({ icon, onIconChange, isIconPickerOpen, onIconOpenChange }: EmojiPickerSectionProps) {
  const [emojiSearch, setEmojiSearch] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">Icon</span>
      <DropdownPicker
        open={isIconPickerOpen}
        onOpenChange={onIconOpenChange}
        trigger={
          <button
            type="button"
            className="flex items-center gap-2 rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm transition hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <span className="text-2xl leading-none">{icon?.startsWith('data:') ? <img src={icon} className="h-6 w-6 rounded" alt="icon" /> : icon}</span>
            <span className="text-muted-foreground text-xs">Change</span>
            <svg className="h-3.5 w-3.5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
          </button>
        }
      >
        <div className="w-[280px] sm:w-80 max-w-[85vw]">
          <div className="mb-2 rounded-md border border-input bg-muted/30 p-2">
            <div className="text-xs text-muted-foreground mb-1">
              Upload your own image or select one below.
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (!file) return
                const reader = new FileReader()
                reader.onload = () => {
                  const img = new Image()
                  img.onload = () => {
                    const maxSize = 128
                    let w = img.width
                    let h = img.height
                    if (w > maxSize || h > maxSize) {
                      const ratio = Math.min(maxSize / w, maxSize / h)
                      w = Math.round(w * ratio)
                      h = Math.round(h * ratio)
                    }
                    const canvas = document.createElement('canvas')
                    canvas.width = w
                    canvas.height = h
                    const ctx = canvas.getContext('2d')!
                    ctx.drawImage(img, 0, 0, w, h)
                    onIconChange(canvas.toDataURL('image/png'))
                    onIconOpenChange(false)
                  }
                  img.src = reader.result as string
                }
                reader.readAsDataURL(file)
              }}
            />
            <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                                    type="button"
                                    className="inline-flex items-center gap-1.5 border border-input rounded-md px-3 py-1.5 text-sm font-medium hover:bg-muted transition"
                                    onClick={() => fileInputRef.current?.click()}
                                  >
                                    <Upload className="h-4 w-4" />
                                    Upload image
                                  </button>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs text-center text-balance">Upload custom icon image</TooltipContent>
                      </Tooltip>
          </div>

          <div className="flex items-center gap-2 rounded-md border border-input bg-background px-2 py-1.5 mb-2">
            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <input
              type="text"
              value={emojiSearch}
              onChange={e => setEmojiSearch(e.target.value)}
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              placeholder="Search or type emoji..."
              autoComplete="off"
            />
            {emojiSearch && (
              <button type="button" onClick={() => setEmojiSearch('')} className="text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div className="max-h-[320px] overflow-y-auto pr-1">
            {emojiSearch ? (
              <div className="grid grid-cols-8 gap-1">
                {EMOJI_CATEGORIES.flatMap(c => c.emojis)
                  .filter(e => emojiMatchesSearch(e, emojiSearch))
                  .map(emoji => (
                    <button
                      key={emoji}
                      type="button"
                      className={cn(
                        'rounded-md p-1.5 text-xl transition hover:scale-110 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                        icon === emoji && 'ring-2 ring-primary bg-muted/70',
                      )}
                      onClick={() => { onIconChange(emoji); onIconOpenChange(false); setEmojiSearch('') }}
                      aria-label={`Select ${emoji}`}
                    >
                      {emoji}
                    </button>
                  ))}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-8 gap-1 mb-2">
                  {FAVORITE_EMOJIS.map(emoji => (
                    <button
                      key={`fav-${emoji}`}
                      type="button"
                      className={cn(
                        'rounded-md p-1.5 text-xl transition hover:scale-110 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                        icon === emoji && 'ring-2 ring-primary bg-muted/70',
                      )}
                      onClick={() => { onIconChange(emoji); onIconOpenChange(false) }}
                      aria-label={`Select ${emoji}`}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>

                {EMOJI_CATEGORIES.map(cat => (
                  <div key={cat.name} className="mb-2">
                    <div className="text-xs font-semibold text-muted-foreground uppercase mb-1">{cat.name}</div>
                    <div className="grid grid-cols-8 gap-1">
                      {cat.emojis.map(emoji => (
                        <button
                          key={emoji}
                          type="button"
                          className={cn(
                            'rounded-md p-1.5 text-xl transition hover:scale-110 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                            icon === emoji && 'ring-2 ring-primary bg-muted/70',
                          )}
                          onClick={() => { onIconChange(emoji); onIconOpenChange(false) }}
                          aria-label={`Select ${emoji}`}
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>

        </div>
      </DropdownPicker>
    </div>
  )
}

const PROJECT_COLORS = [
  { name: 'Ocean Blue', value: '#0ea5e9' },
  { name: 'Royal Blue', value: '#3b82f6' },
  { name: 'Sapphire', value: '#2563eb' },
  { name: 'Indigo', value: '#6366f1' },
  { name: 'Violet', value: '#8b5cf6' },
  { name: 'Purple', value: '#a855f7' },
  { name: 'Fuchsia', value: '#d946ef' },
  { name: 'Charcoal', value: '#374151' },
  { name: 'Midnight', value: '#1e293b' },
  { name: 'Forest', value: '#166534' },
  { name: 'Teal', value: '#14b8a6' },
  { name: 'Cyan', value: '#06b6d4' },
  { name: 'Emerald', value: '#10b981' },
  { name: 'Green', value: '#22c55e' },
  { name: 'Lime', value: '#84cc16' },
  { name: 'Slate', value: '#64748b' },
]

export interface ColorPickerSectionProps {
  color: string
  onColorChange: (color: string) => void
  isColorPickerOpen: boolean
  onColorOpenChange: (open: boolean) => void
}

export function ColorPickerSection({ color, onColorChange, isColorPickerOpen, onColorOpenChange }: ColorPickerSectionProps) {
  const selectedColor = PROJECT_COLORS.find(c => c.value === color)

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">Color</span>
      <DropdownPicker
        open={isColorPickerOpen}
        onOpenChange={onColorOpenChange}
        trigger={
          <button
            type="button"
            className="flex items-center gap-2 rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm transition hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <span className="h-5 w-5 rounded-full border border-background shadow-sm" style={{ backgroundColor: color }} />
            <span className="text-muted-foreground text-xs">{selectedColor?.name ?? 'Custom'}</span>
            <svg className="h-3.5 w-3.5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
          </button>
        }
      >
        <div className="w-[240px] sm:w-64 max-w-[85vw]">
          <div className="grid grid-cols-4 gap-2">
            {PROJECT_COLORS.map(c => (
              <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                                key={c.value}
                                type="button"
                                className="group flex flex-col items-center gap-1 rounded-lg p-1 transition hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                                onClick={() => { onColorChange(c.value); onColorOpenChange(false) }}
                              >
                                <span
                                  className={cn(
                                    'flex h-9 w-9 items-center justify-center rounded-full border border-background shadow-sm transition-transform group-hover:scale-110',
                                    color === c.value && 'ring-2 ring-primary ring-offset-1',
                                  )}
                                  style={{ backgroundColor: c.value }}
                                >
                                  {color === c.value && <span className="text-xs font-bold text-white">✓</span>}
                                </span>
                                <span className="text-[10px] leading-tight text-muted-foreground text-center">{c.name}</span>
                              </button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs text-center text-balance">{c.name}</TooltipContent>
                </Tooltip>
            ))}
          </div>
        </div>
      </DropdownPicker>
    </div>
  )
}
