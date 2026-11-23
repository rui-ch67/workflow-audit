// Fixture projects, written to a temp dir at test time.
// Kept as data (not folders) so no fixture .claude/skills/ is ever discovered as a real skill.

const lines = (n, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n');

export const FIXTURES = {
  'solo-app': {
    'package.json': JSON.stringify({ name: 'solo', scripts: { test: 'node --test', lint: 'eslint .', build: 'node build.js' } }),
    'eslint.config.js': 'export default [];\n',
    'CLAUDE.md': [
      '# Solo app',
      '',
      '## Commands',
      '- `npm test` runs the unit tests (node:test, no watcher).',
      '- `npm run lint` must pass before commit.',
      '',
      '## Gotchas',
      '- Dates are stored as UTC strings; never use local time in `src/date.js`.',
    ].join('\n'),
    'src/index.js': 'export const a = 1;\n',
    'src/date.js': 'export const d = 1;\n',
    'src/util.js': 'export const u = 1;\n',
    'src/index.test.js': 'import "node:test";\n',
    '.github/workflows/ci.yml': 'jobs:\n  test:\n    steps:\n      - run: npm test\n',
  },

  monorepo: {
    'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'], scripts: { test: 'turbo test', build: 'turbo build' } }),
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    'packages/web/package.json': JSON.stringify({ name: 'web', scripts: { test: 'vitest' } }),
    'packages/web/src/a.ts': 'export {}\n',
    'packages/web/src/b.ts': 'export {}\n',
    'packages/web/src/c.ts': 'export {}\n',
    'packages/api/package.json': JSON.stringify({ name: 'api' }),
    'packages/api/src/a.ts': 'export {}\n',
    'tsconfig.json': '{}\n',
    'CLAUDE.md': [
      '# Mono',
      '',
      'Deploy with `npm run deploy`.',
      '',
      '```',
      '.',
      ...Array.from({ length: 18 }, (_, i) => `├── packages/pkg${i}/src/index.ts`),
      '└── README.md',
      '```',
    ].join('\n'),
  },

  'docs-only': {
    'README.md': '# Handbook\n',
    'CLAUDE.md': '# Handbook\n\n- Run `npx markdownlint-cli2 "**/*.md"` before publishing.\n- Guides live in `guides/`.\n',
    '.markdownlint.json': '{}\n',
    'guides/onboarding.md': `# Onboarding\n${lines(12)}\nSee policies.md.\n`,
    'guides/policies.md': `# Policies\n${lines(12)}\nSee onboarding.md and faq.md.\n`,
    'guides/faq.md': `# FAQ\n${lines(12)}\n`,
  },

  empty: {},

  'over-engineered-small': {
    'package.json': JSON.stringify({ name: 'tiny', scripts: { test: 'node --test', deploy: 'vercel --prod' } }),
    'index.js': 'export {}\n',
    'index.test.js': 'import "node:test";\n',
    'eslint.config.js': 'export default [];\n',
    'CLAUDE.md': '# Tiny\n\nIMPORTANT: NEVER read the .env file.\n\nRun `npm test`.\n',
    ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [
      `.claude/agents/agent${i}.md`,
      `---\nname: agent${i}\ndescription: Helpful assistant ${i}\n---\nDo things.\n`,
    ])),
    '.claude/skills/deploy/SKILL.md': `---\nname: deploy\ndescription: ${'x'.repeat(1600)}\n---\n${lines(6, 'step')}\nRun scripts/go.sh\n`,
    '.claude/skills/deploy/scripts/go.sh': 'echo deploy\n',
  },
};
