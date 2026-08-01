// Static model catalog: mentions a removed slug but never invokes Workers AI
// (no AI binding invocation, no REST run URL). The pack's file-level guard
// must leave this file byte-identical — docs and catalogs are not call sites.
export const KNOWN_MODELS = [
  { slug: '@cf/baai/omni-bge-m3', kind: 'embedding', note: 'legacy alias listed for the deprecation notice UI' },
  { slug: '@cf/meta/llama-3.1-8b-instruct', kind: 'text-generation' },
];
