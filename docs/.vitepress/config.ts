import crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitepress'

const githubRepo = 'https://github.com/looptroop-ai/LoopTroop'

const sidebar = [
  {
    text: 'Start Here',
    collapsed: false,
    items: [
      { text: 'Home', link: '/' },
      { text: 'Getting Started', link: '/getting-started' },
      { text: 'Core Philosophy', link: '/core-philosophy' },
      { text: 'Context Engineering', link: '/context-engineering' },
    ],
  },
  {
    text: 'Workflow',
    collapsed: false,
    items: [
      { text: 'Ticket Flow', link: '/ticket-flow' },
      { text: 'Interview', link: '/interview' },
      { text: 'PRD', link: '/prd' },
      { text: 'LLM Council', link: '/llm-council' },
      { text: 'Beads & Execution', link: '/beads' },
      { text: 'Pre-Implementation', link: '/pre-implementation' },
      { text: 'Post-Implementation', link: '/post-implementation' },
    ],
  },
  {
    text: 'Architecture',
    collapsed: false,
    items: [
      { text: 'System Architecture', link: '/system-architecture' },
      { text: 'OpenCode Integration', link: '/opencode-integration' },
      { text: 'Frontend', link: '/frontend' },
      { text: 'Database Schema', link: '/database-schema' },
    ],
  },
  {
    text: 'Reference',
    collapsed: false,
    items: [
      { text: 'Configuration', link: '/configuration' },
      { text: 'Prompt Inventory', link: '/prompts' },
      { text: 'API Reference', link: '/api-reference' },
      { text: 'Output Normalization', link: '/output-normalization' },
    ],
  },
  {
    text: 'Operations',
    collapsed: false,
    items: [
      { text: 'Operations Guide', link: '/operations' },
      { text: 'Runtime Diagnostics', link: '/diagnostics' },
    ],
  },
  {
    text: 'Direction',
    collapsed: false,
    items: [
      { text: 'Changelog', link: '/changelog' },
      { text: 'Roadmap', link: '/roadmap' },
    ],
  },
]

export default defineConfig({
  base: '/docs/',
  title: 'LoopTroop',
  description: 'Durable repo-scale AI delivery through council planning, isolated worktrees, and explicit approvals.',
  vite: {
    build: {
      // The generated local-search index is intentionally a single searchable
      // asset and currently sits below this documented docs-only budget.
      chunkSizeWarningLimit: 850,
    },
  },
  head: [
    ['link', { rel: 'icon', href: '/favicon.ico?v=20260429', sizes: 'any' }],
    ['link', { rel: 'icon', type: 'image/png', sizes: '256x256', href: '/favicon.png?v=20260429' }],
    ['link', { rel: 'apple-touch-icon', href: '/trans-logo.png?v=20260429' }],
    [
      'script',
      {},
      `
      (function() {
        const collapsed = localStorage.getItem('sidebar-collapsed');
        if (collapsed === 'true') {
          document.documentElement.classList.add('sidebar-collapsed');
        }
        const outlineCollapsed = localStorage.getItem('outline-collapsed');
        if (outlineCollapsed === 'true') {
          document.documentElement.classList.add('outline-collapsed');
        }
      })();
      `
    ]
  ],
  cleanUrls: true,
  lastUpdated: true,
  transformPageData(pageData) {
    try {
      const commitHash = execSync(
        `git log -1 --pretty="%H" -- "docs/${pageData.relativePath}"`
      ).toString().trim()
      if (commitHash) {
        pageData.frontmatter.lastUpdatedCommitHash = commitHash
        const relativeFilePath = `docs/${pageData.relativePath}`
        const fileDiffHash = crypto
          .createHash('sha256')
          .update(relativeFilePath)
          .digest('hex')
        pageData.frontmatter.lastUpdatedFileDiffHash = fileDiffHash
      }
    } catch (e) {
      // ignore
    }
  },
  markdown: {
    config(md) {
      md.set({ html: false })

      const defaultFence = md.renderer.rules.fence?.bind(md.renderer.rules)

      md.renderer.rules.fence = (tokens, idx, options, env, self) => {
        const token = tokens[idx]
        if (token.info.trim() === 'mermaid') {
          const encoded = encodeURIComponent(token.content)
          return `<MermaidBlock encoded="${encoded}" />`
        }

        if (defaultFence) {
          return defaultFence(tokens, idx, options, env, self)
        }

        return self.renderToken(tokens, idx, options)
      }
    },
  },
  themeConfig: {
    siteTitle: 'LoopTroop Docs',
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Workflow', link: '/ticket-flow' },
      { text: 'Architecture', link: '/system-architecture' },
      { text: 'Changelog', link: '/changelog' },
      { text: 'Roadmap', link: '/roadmap' },
      { 
        text: '<div style="display:flex;align-items:center;gap:6px;"><svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>GitHub</div>', 
        link: githubRepo,
        target: '_blank',
        noIcon: true 
      },
    ],
    sidebar,
    search: {
      provider: 'local',
    },
    outline: {
      level: [2, 3],
      label: 'On this page',
    },
    editLink: {
      pattern: `${githubRepo}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub',
    },
    socialLinks: [],
    docFooter: {
      prev: 'Previous',
      next: 'Next',
    },
    footer: {
      message: 'LoopTroop documentation for the current runtime.',
      copyright: 'Built for durable repository-scale AI delivery.',
    },
  },
})
