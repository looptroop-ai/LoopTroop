import { cp, copyFile, mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { execSync } from 'node:child_process'

const root = process.cwd()
const siteDir = path.join(root, 'site')
const docsDistDir = path.join(root, 'docs/.vitepress/dist')

console.log('Cleaning site directory...')
await rm(siteDir, { recursive: true, force: true })
await mkdir(path.join(siteDir, 'docs'), { recursive: true })

console.log('Compiling Tailwind CSS for landing page...')
execSync('tailwindcss -i src/web.css -o site/web.css --minify', { stdio: 'inherit' })

console.log('Reading package.json version...')
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf-8'))
const version = pkg.version

console.log(`Processing web.html with version: ${version}...`)
let webHtml = await readFile(path.join(root, 'web.html'), 'utf-8')
webHtml = webHtml.replaceAll('{{VERSION}}', version)
await writeFile(path.join(siteDir, 'index.html'), webHtml)

console.log('Copying public files...')
await cp(path.join(root, 'public'), siteDir, { recursive: true })

console.log('Copying WebP screenshots to site/media...')
const mediaDest = path.join(siteDir, 'media')
await mkdir(mediaDest, { recursive: true })
const mediaSrc = path.join(root, 'docs', 'media')
const mediaFiles = await readdir(mediaSrc)
for (const file of mediaFiles) {
  if (file.endsWith('.webp')) {
    await copyFile(path.join(mediaSrc, file), path.join(mediaDest, file))
  }
}

console.log('Copying documentation site...')
await cp(docsDistDir, path.join(siteDir, 'docs'), { recursive: true })

// Keep legacy screenshot links working for older cached marketing pages.
console.log('Copying legacy assets...')
await cp(path.join(docsDistDir, 'assets'), path.join(siteDir, 'assets'), { recursive: true })

console.log('Build completed successfully.')
