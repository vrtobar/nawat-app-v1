import node from '@nahuat/config/eslint/node';

export default [
  ...node,
  {
    // scripts/ and the vitest config sit outside tsconfig.json's
    // `include: ["src"]`, so the type-aware project service resolves no project
    // for them and cannot parse them at all.
    //
    // Linted WITHOUT a project rather than given one. apps/api and
    // packages/database each point these at a tsconfig.tools.json, but neither
    // exists here and adding one means deciding what it emits and wiring it
    // into typecheck — more than lint coverage needs. The syntactic and
    // import-order rules apply either way, and before this file existed
    // nothing in this package was linted at all.
    //
    // Worth knowing: scripts/generate-contracts.ts is not type-checked either.
    // CI asserts its OUTPUT matches the committed contracts, which catches a
    // wrong result but not a latent type error in how it gets there.
    files: ['scripts/**/*.ts', '*.config.mts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: null,
      },
    },
  },
];
