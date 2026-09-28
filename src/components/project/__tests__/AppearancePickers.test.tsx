import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ColorPickerSection, EmojiPickerSection } from '../AppearancePickers'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('EmojiPickerSection', () => {
  it('filters emoji by name, restores the favorites, and reports the selected icon', () => {
    const onIconChange = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <TooltipProvider>
        <EmojiPickerSection icon="🐱" onIconChange={onIconChange} isIconPickerOpen onIconOpenChange={onOpenChange} />
      </TooltipProvider>,
    )

    const search = screen.getByPlaceholderText('Search or type emoji...')
    fireEvent.change(search, { target: { value: 'cat' } })
    expect(screen.getByRole('button', { name: 'Select 🐱' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Select 😀' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Select 🐱' }))
    expect(onIconChange).toHaveBeenCalledWith('🐱')
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(search).toHaveValue('')

    fireEvent.change(search, { target: { value: 'no matching emoji' } })
    expect(screen.queryByRole('button', { name: /^Select / })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear emoji search' }))
    expect(screen.getAllByRole('button', { name: 'Select 😀' })).toHaveLength(2)
  })

  it('selects a favorite or category emoji and previews uploaded image icons', () => {
    const onIconChange = vi.fn()
    const onOpenChange = vi.fn()
    const view = render(
      <TooltipProvider>
        <EmojiPickerSection icon="😀" onIconChange={onIconChange} isIconPickerOpen onIconOpenChange={onOpenChange} />
      </TooltipProvider>,
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'Select 😀' })[0]!)
    expect(onIconChange).toHaveBeenLastCalledWith('😀')
    fireEvent.click(screen.getByRole('button', { name: 'Select 🐙' }))
    expect(onIconChange).toHaveBeenLastCalledWith('🐙')
    expect(onOpenChange).toHaveBeenLastCalledWith(false)

    view.rerender(
      <TooltipProvider>
        <EmojiPickerSection icon="data:image/png;base64,preview" onIconChange={onIconChange} isIconPickerOpen={false} onIconOpenChange={onOpenChange} />
      </TooltipProvider>,
    )
    expect(screen.getByAltText('icon')).toHaveAttribute('src', 'data:image/png;base64,preview')
  })

  it.each([
    { width: 256, height: 64, scaledWidth: 128, scaledHeight: 32 },
    { width: 64, height: 256, scaledWidth: 32, scaledHeight: 128 },
    { width: 64, height: 64, scaledWidth: 64, scaledHeight: 64 },
  ])('ignores empty uploads and constrains a $width by $height icon to 128px', ({ width, height, scaledWidth, scaledHeight }) => {
    const onIconChange = vi.fn()
    const onOpenChange = vi.fn()

    class MockFileReader {
      result: string | ArrayBuffer | null = null
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null

      readAsDataURL(file: Blob) {
        this.result = `data:${file.type};base64,source`
        this.onload?.({} as ProgressEvent<FileReader>)
      }
    }
    class MockImage {
      width = width
      height = height
      onload: (() => void) | null = null

      set src(_value: string) {
        this.onload?.()
      }
    }

    vi.stubGlobal('FileReader', MockFileReader)
    vi.stubGlobal('Image', MockImage)
    const context = { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,scaled')

    render(
      <TooltipProvider>
        <EmojiPickerSection icon="📦" onIconChange={onIconChange} isIconPickerOpen onIconOpenChange={onOpenChange} />
      </TooltipProvider>,
    )
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    const openFilePicker = vi.spyOn(input, 'click').mockImplementation(() => undefined)
    fireEvent.click(screen.getByRole('button', { name: 'Upload image' }))
    expect(openFilePicker).toHaveBeenCalledTimes(1)
    fireEvent.change(input, { target: { files: [] } })
    expect(onIconChange).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { files: [new File(['image'], 'project.png', { type: 'image/png' })] } })

    expect(context.drawImage).toHaveBeenCalledWith(expect.any(MockImage), 0, 0, scaledWidth, scaledHeight)
    expect(onIconChange).toHaveBeenCalledWith('data:image/png;base64,scaled')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe('ColorPickerSection', () => {
  it('labels custom colors and closes after a named color is selected', () => {
    const onColorChange = vi.fn()
    const onOpenChange = vi.fn()
    const view = render(
      <TooltipProvider>
        <ColorPickerSection color="#123456" onColorChange={onColorChange} isColorPickerOpen onColorOpenChange={onOpenChange} />
      </TooltipProvider>,
    )

    expect(screen.getByText('Custom')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Forest' }))
    expect(onColorChange).toHaveBeenCalledWith('#166534')
    expect(onOpenChange).toHaveBeenCalledWith(false)

    view.rerender(
      <TooltipProvider>
        <ColorPickerSection color="#0ea5e9" onColorChange={onColorChange} isColorPickerOpen={false} onColorOpenChange={onOpenChange} />
      </TooltipProvider>,
    )
    expect(screen.getByText('Ocean Blue')).toBeInTheDocument()
  })
})
