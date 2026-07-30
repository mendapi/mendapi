// Star re-export fixture: `export *` forwards the whole named export table of
// clientmod.mjs but — per the ESM spec — never its default export. Consumers
// importing named members through this file must resolve; a default import of
// this file must never bind.
export * from './clientmod.mjs';
