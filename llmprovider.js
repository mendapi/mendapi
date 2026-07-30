#!/usr/bin/env node
// llmprovider.js — Provider-agnostic LLM interface for BYO compute.
// Zero npm dependencies. This module BUILDS requests only — it performs no
// network I/O whatsoever (mechanically enforced by the test suite).
//
// Security model (D3): mendapi never ships with a baked-in LLM vendor or key.
// Customers bring their own compute: an OpenAI/Anthropic key, an
// OpenAI-compatible endpoint (vLLM, Ollama, LM Studio, corporate gateway), or
// a fully local runtime. Design principles:
//
//   1. NO NETWORK — this module resolves configuration and builds request
//      descriptors ({ url, headers, body }) as plain data. Any transport
//      layer that actually sends them must live in a separate, explicitly
//      opt-in module (mirrors the --report-to gate for payload.js).
//   2. NO DEFAULT PROVIDER — if the user has not configured a provider,
//      resolution fails loudly. mendapi's deterministic rule packs work
//      without any LLM; the LLM layer is strictly additive.
//   3. KEY HYGIENE — API keys are read from environment variables or an
//      explicit config object, are never logged, and are masked in any
//      serialized/debug form of a request descriptor.
//
// Configuration (environment variables, or pass a config object):
//   MENDAPI_LLM_PROVIDER   openai | anthropic | openai-compatible
//   MENDAPI_LLM_API_KEY    provider API key (optional for openai-compatible)
//   MENDAPI_LLM_BASE_URL   required for openai-compatible (e.g. http://localhost:11434/v1)
//   MENDAPI_LLM_MODEL      model name (required)
//
// CLI:
//   node app/llmprovider.js --self-test     run built-in unit tests
//   node app/llmprovider.js --show-config   print resolved config (key masked)

'use strict';

const AUTH_MASK = '[MASKED]';

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

export const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    requiresKey: true,
    buildRequest({ baseUrl, apiKey, model, system, prompt, maxTokens }) {
      return {
        url: `${baseUrl.replace(/\/$/, '')}/chat/completions`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: {
          model,
          max_tokens: maxTokens,
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: prompt },
          ],
        },
      };
    },
    extractText(responseBody) {
      return responseBody?.choices?.[0]?.message?.content ?? null;
    },
  },

  anthropic: {
    label: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    requiresKey: true,
    buildRequest({ baseUrl, apiKey, model, system, prompt, maxTokens }) {
      return {
        url: `${baseUrl.replace(/\/$/, '')}/messages`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: {
          model,
          max_tokens: maxTokens,
          ...(system ? { system } : {}),
          messages: [{ role: 'user', content: prompt }],
        },
      };
    },
    extractText(responseBody) {
      const block = responseBody?.content?.find((b) => b?.type === 'text');
      return block?.text ?? null;
    },
  },

  'openai-compatible': {
    label: 'OpenAI-compatible endpoint (vLLM, Ollama, LM Studio, gateway)',
    defaultBaseUrl: null, // must be provided by the user
    requiresKey: false, // local endpoints often need none
    buildRequest({ baseUrl, apiKey, model, system, prompt, maxTokens }) {
      return {
        url: `${baseUrl.replace(/\/$/, '')}/chat/completions`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: {
          model,
          max_tokens: maxTokens,
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: prompt },
          ],
        },
      };
    },
    extractText(responseBody) {
      return responseBody?.choices?.[0]?.message?.content ?? null;
    },
  },
};

// ---------------------------------------------------------------------------
// Configuration resolution
// ---------------------------------------------------------------------------

export class LlmConfigError extends Error {}

export function resolveConfig(overrides = {}, env = process.env) {
  const provider = overrides.provider ?? env.MENDAPI_LLM_PROVIDER ?? null;
  if (!provider) {
    throw new LlmConfigError(
      'No LLM provider configured. mendapi works without one (deterministic rule packs); ' +
        'to enable LLM-assisted fixes, set MENDAPI_LLM_PROVIDER to one of: ' +
        Object.keys(PROVIDERS).join(', '),
    );
  }
  const def = PROVIDERS[provider];
  if (!def) {
    throw new LlmConfigError(
      `Unknown LLM provider "${provider}". Supported: ${Object.keys(PROVIDERS).join(', ')}`,
    );
  }

  const apiKey = overrides.apiKey ?? env.MENDAPI_LLM_API_KEY ?? null;
  if (def.requiresKey && !apiKey) {
    throw new LlmConfigError(
      `Provider "${provider}" requires an API key. Set MENDAPI_LLM_API_KEY (your key stays on your machine).`,
    );
  }

  const baseUrl = overrides.baseUrl ?? env.MENDAPI_LLM_BASE_URL ?? def.defaultBaseUrl;
  if (!baseUrl) {
    throw new LlmConfigError(
      `Provider "${provider}" requires a base URL. Set MENDAPI_LLM_BASE_URL (e.g. http://localhost:11434/v1).`,
    );
  }
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new LlmConfigError(`Invalid base URL "${baseUrl}": must start with http:// or https://`);
  }

  const model = overrides.model ?? env.MENDAPI_LLM_MODEL ?? null;
  if (!model) {
    throw new LlmConfigError(`Provider "${provider}" requires a model name. Set MENDAPI_LLM_MODEL.`);
  }

  return { provider, apiKey, baseUrl, model };
}

// ---------------------------------------------------------------------------
// Request building (pure data — nothing is sent)
// ---------------------------------------------------------------------------

export function buildRequest(config, { system = null, prompt, maxTokens = 2048 }) {
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new LlmConfigError('buildRequest: prompt must be a non-empty string');
  }
  const def = PROVIDERS[config.provider];
  if (!def) throw new LlmConfigError(`Unknown provider "${config.provider}"`);
  return def.buildRequest({ ...config, system, prompt, maxTokens });
}

export function extractText(providerName, responseBody) {
  const def = PROVIDERS[providerName];
  if (!def) throw new LlmConfigError(`Unknown provider "${providerName}"`);
  return def.extractText(responseBody);
}

// Mask credentials in a request descriptor for logging/debugging.
export function maskRequest(req) {
  const headers = { ...req.headers };
  for (const k of Object.keys(headers)) {
    if (/^(authorization|x-api-key)$/i.test(k)) headers[k] = AUTH_MASK;
  }
  return { ...req, headers };
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

function selfTest() {
  let pass = 0;
  let fail = 0;
  const t = (name, fn) => {
    try {
      fn();
      pass++;
      console.log(`PASS: ${name}`);
    } catch (e) {
      fail++;
      console.log(`FAIL: ${name} — ${e.message}`);
    }
  };
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };

  t('no provider configured fails loudly', () => {
    let threw = false;
    try {
      resolveConfig({}, {});
    } catch (e) {
      threw = e instanceof LlmConfigError && /No LLM provider/.test(e.message);
    }
    assert(threw, 'expected LlmConfigError');
  });

  t('unknown provider rejected', () => {
    let threw = false;
    try {
      resolveConfig({}, { MENDAPI_LLM_PROVIDER: 'skynet' });
    } catch (e) {
      threw = /Unknown LLM provider/.test(e.message);
    }
    assert(threw, 'expected unknown-provider error');
  });

  t('openai requires api key', () => {
    let threw = false;
    try {
      resolveConfig({}, { MENDAPI_LLM_PROVIDER: 'openai', MENDAPI_LLM_MODEL: 'gpt-x' });
    } catch (e) {
      threw = /requires an API key/.test(e.message);
    }
    assert(threw, 'expected missing-key error');
  });

  t('openai request shape', () => {
    const cfg = resolveConfig(
      {},
      { MENDAPI_LLM_PROVIDER: 'openai', MENDAPI_LLM_API_KEY: 'k1', MENDAPI_LLM_MODEL: 'gpt-x' },
    );
    const req = buildRequest(cfg, { system: 'sys', prompt: 'hello' });
    assert(req.url === 'https://api.openai.com/v1/chat/completions', 'url');
    assert(req.headers.authorization === 'Bearer k1', 'auth header');
    assert(req.body.messages.length === 2 && req.body.messages[0].role === 'system', 'messages');
  });

  t('anthropic request shape', () => {
    const cfg = resolveConfig(
      {},
      { MENDAPI_LLM_PROVIDER: 'anthropic', MENDAPI_LLM_API_KEY: 'k2', MENDAPI_LLM_MODEL: 'claude-x' },
    );
    const req = buildRequest(cfg, { system: 'sys', prompt: 'hello' });
    assert(req.url === 'https://api.anthropic.com/v1/messages', 'url');
    assert(req.headers['x-api-key'] === 'k2', 'key header');
    assert(req.body.system === 'sys' && req.body.messages.length === 1, 'system top-level');
  });

  t('openai-compatible requires base url, key optional', () => {
    let threw = false;
    try {
      resolveConfig({}, { MENDAPI_LLM_PROVIDER: 'openai-compatible', MENDAPI_LLM_MODEL: 'm' });
    } catch (e) {
      threw = /requires a base URL/.test(e.message);
    }
    assert(threw, 'expected missing-base-url error');
    const cfg = resolveConfig(
      {},
      {
        MENDAPI_LLM_PROVIDER: 'openai-compatible',
        MENDAPI_LLM_BASE_URL: 'http://localhost:11434/v1',
        MENDAPI_LLM_MODEL: 'llama3',
      },
    );
    const req = buildRequest(cfg, { prompt: 'hi' });
    assert(req.url === 'http://localhost:11434/v1/chat/completions', 'url');
    assert(!('authorization' in req.headers), 'no auth header without key');
  });

  t('invalid base url rejected', () => {
    let threw = false;
    try {
      resolveConfig(
        {},
        {
          MENDAPI_LLM_PROVIDER: 'openai-compatible',
          MENDAPI_LLM_BASE_URL: 'file:///etc/passwd',
          MENDAPI_LLM_MODEL: 'm',
        },
      );
    } catch (e) {
      threw = /Invalid base URL/.test(e.message);
    }
    assert(threw, 'expected invalid-url error');
  });

  t('maskRequest hides credentials', () => {
    const cfg = resolveConfig(
      {},
      { MENDAPI_LLM_PROVIDER: 'openai', MENDAPI_LLM_API_KEY: 'supersecret', MENDAPI_LLM_MODEL: 'gpt-x' },
    );
    const masked = maskRequest(buildRequest(cfg, { prompt: 'p' }));
    const serialized = JSON.stringify(masked);
    assert(!serialized.includes('supersecret'), 'key leaked in masked request');
    assert(serialized.includes(AUTH_MASK), 'mask marker missing');
  });

  t('extractText per provider', () => {
    assert(
      extractText('openai', { choices: [{ message: { content: 'A' } }] }) === 'A',
      'openai extract',
    );
    assert(
      extractText('anthropic', { content: [{ type: 'text', text: 'B' }] }) === 'B',
      'anthropic extract',
    );
    assert(extractText('openai', {}) === null, 'missing content returns null');
  });

  t('empty prompt rejected', () => {
    const cfg = resolveConfig(
      {},
      { MENDAPI_LLM_PROVIDER: 'openai', MENDAPI_LLM_API_KEY: 'k', MENDAPI_LLM_MODEL: 'm' },
    );
    let threw = false;
    try {
      buildRequest(cfg, { prompt: '' });
    } catch (e) {
      threw = /non-empty string/.test(e.message);
    }
    assert(threw, 'expected empty-prompt error');
  });

  console.log(`SELF-TEST RESULT: PASS=${pass} FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

import { pathToFileURL } from 'node:url';

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    selfTest();
  } else if (argv.includes('--show-config')) {
    try {
      const cfg = resolveConfig();
      console.log(
        JSON.stringify({ ...cfg, apiKey: cfg.apiKey ? AUTH_MASK : null }, null, 2),
      );
    } catch (e) {
      console.error(e.message);
      process.exit(2);
    }
  } else {
    console.error('Usage: node app/llmprovider.js --self-test | --show-config');
    process.exit(2);
  }
}
