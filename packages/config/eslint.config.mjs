import node from './eslint/node.js';

// This package lints itself with the config it publishes, which is the point:
// a change here that breaks the rules breaks them for every workspace, and this
// is where that shows up first.
//
// Imported by relative path rather than through '@nahuat/config/eslint/node' —
// the package cannot resolve its own exports map, and a self-reference would be
// a cycle to no benefit.
//
// The base config already turns off type-aware analysis for **/*.{js,mjs,cjs},
// so the four plain-ESM files here need no override; they get the syntactic
// rules and import ordering and nothing that requires a tsconfig, which this
// package does not have.
export default [...node];
