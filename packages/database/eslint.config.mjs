import node from '@nahuat/config/eslint/node';

export default [
  ...node,
  {
    // prisma.config.ts and prisma/**/*.ts sit outside tsconfig.json's
    // `include: ["src"]`, so the type-aware project service resolves no project
    // for them and cannot parse them at all — the same failure apps/api hit on
    // its scripts/ directory. tsconfig.tools.json is the config that covers
    // them, and it exists because typecheck needed exactly this split.
    files: ['prisma.config.ts', 'prisma/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: './tsconfig.tools.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The integration suite and its vitest configs, WITHOUT type-aware rules.
    // They are ESM and use `import.meta`; this package emits CommonJS, so
    // putting them in tsconfig.tools.json produces TS1470 on every occurrence
    // rather than useful type information. Parsing them without a project
    // keeps the syntactic and import-order rules, which is what was missing —
    // before this file existed nothing here was linted at all.
    files: ['test/**/*.ts', '*.config.mts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: null,
      },
    },
  },
];
