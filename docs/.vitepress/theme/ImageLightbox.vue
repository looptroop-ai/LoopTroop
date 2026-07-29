<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vitepress'

const route = useRoute()

const isOpen = ref(false)
const imageSrc = ref('')
const imageAlt = ref('')

const docsImageSelector = '.VPDoc .content-container img:not(.image-lightbox__image)'

function getDocsImage(target: EventTarget | null): HTMLImageElement | null {
  if (!(target instanceof Element)) {
    return null
  }

  return target.closest<HTMLImageElement>(docsImageSelector)
}

function decorateImages() {
  document.querySelectorAll<HTMLImageElement>(docsImageSelector).forEach((image) => {
    image.classList.add('docs-clickable-image')
    image.setAttribute('role', 'button')
    image.setAttribute('tabindex', '0')

    const label = image.alt ? `Open screenshot: ${image.alt}` : 'Open documentation image'
    image.setAttribute('aria-label', label)
  })
}

function revealLifecycleScreenshots() {
  document.querySelectorAll<HTMLDetailsElement>('.ticket-lifecycle-page .VPDoc details.custom-block').forEach((details) => {
    details.open = true
  })
}

function openImage(image: HTMLImageElement) {
  const src = image.currentSrc || image.src
  if (!src) {
    return
  }

  imageSrc.value = src
  imageAlt.value = image.alt || 'Documentation screenshot'
  isOpen.value = true
  document.documentElement.classList.add('image-lightbox-open')
}

function closeImage() {
  isOpen.value = false
  imageSrc.value = ''
  imageAlt.value = ''
  document.documentElement.classList.remove('image-lightbox-open')
}

function handleClick(event: MouseEvent) {
  const image = getDocsImage(event.target)
  if (!image || event.button !== 0) {
    return
  }

  event.preventDefault()
  openImage(image)
}

function handleKeydown(event: KeyboardEvent) {
  if (isOpen.value && event.key === 'Escape') {
    event.preventDefault()
    closeImage()
    return
  }

  if (event.key !== 'Enter' && event.key !== ' ') {
    return
  }

  const image = getDocsImage(event.target)
  if (!image) {
    return
  }

  event.preventDefault()
  openImage(image)
}

onMounted(() => {
  revealLifecycleScreenshots()
  decorateImages()
  document.addEventListener('click', handleClick)
  document.addEventListener('keydown', handleKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleClick)
  document.removeEventListener('keydown', handleKeydown)
  closeImage()
})

watch(
  () => route.path,
  () => {
    closeImage()
    void nextTick(() => {
      revealLifecycleScreenshots()
      decorateImages()
    })
  },
)
</script>

<template>
  <div
    v-if="isOpen"
    class="image-lightbox"
    role="dialog"
    aria-modal="true"
    :aria-label="imageAlt"
    @click.self="closeImage"
  >
    <button class="image-lightbox__close" type="button" @click="closeImage">
      Close
    </button>
    <figure class="image-lightbox__figure">
      <img class="image-lightbox__image" :src="imageSrc" :alt="imageAlt" />
      <figcaption class="image-lightbox__caption">{{ imageAlt }}</figcaption>
    </figure>
  </div>
</template>
