#!/usr/bin/env node
// llmtransport.js — the ONLY module in mendapi that may send LLM traffic.
// Zero npm dependencies. Explicitly opt-in: nothing in mendapi imports this
// module unconditionally. Callers (review --llm, future fixer --llm) load it
// dynamically ONLY after the user passes an explicit --llm flag AND has
// configured a provider via llmprovider.js. This mirrors the payload.js
// --report-to gate: a security auditor can read this one file and know the
// complete LLM egress surface of the product.
//
// Security model (D3):
//   1. No default egress — this module is never loaded unless the user opts in.
//   2. Destination is user-controlled — the URL comes from the user's own
//      provider config (their key, their endpoint). mendapi has no vendor.
//   3. Key hygiene — errors and logs never include credentials; failures are
//      reported with maskRequest() output only.
//   4. Injectable transport — sendRequest accepts a custom send function so
//      the test suite never touches the network.

'use strict';

import { maskRequest } from './llmprovider.js';

export class LlmTransportError extends Error {}

const DEFAULT_TIMEOUT_MS = 60_000;

// Send a request descriptor built by llmprovider.buildRequest().
// opts.sendFn: injectable (url, init) => Promise<{ status, json() }> for tests.
export async function sendRequest(req, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sendFn = opts.sendFn ?? globalThis.fetch;
  if (typeof sendFn !== 'function') {
    throw new LlmTransportError('No transport available (fetch missing and no sendFn injected)');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await sendFn(req.url, {
      method: req.method,
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: controller.signal,
    });
  } catch (e) {
    const masked = JSON.stringify(maskRequest(req).headers);
    throw new LlmTransportError(
      `LLM request to ${req.url} failed: ${e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : e.message} (headers: ${masked})`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res || typeof res.status !== 'number') {
    throw new LlmTransportError('Transport returned an invalid response object');
  }
  if (res.status < 200 || res.status >= 300) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { /* body optional */ }
    throw new LlmTransportError(`LLM endpoint ${req.url} returned HTTP ${res.status}: ${detail}`);
  }
  try {
    return await res.json();
  } catch {
    throw new LlmTransportError('LLM endpoint returned non-JSON response body');
  }
}

// Convenience: build + send + extract in one call. config comes from
// llmprovider.resolveConfig() — i.e. the user has already opted in.
export async function complete(config, { system = null, prompt, maxTokens = 2048 }, opts = {}) {
  const { buildRequest, extractText } = await import('./llmprovider.js');
  const req = buildRequest(config, { system, prompt, maxTokens });
  const body = await sendRequest(req, opts);
  const text = extractText(config.provider, body);
  if (text == null) {
    throw new LlmTransportError('LLM response contained no text content');
  }
  return text;
}

// ---------------------------------------------------------------------------
// Self-test (no network: all transports are injected fakes)
// ---------------------------------------------------------------------------

async function selfTest() {
  let pass = 0;
  let fail = 0;
  const t = async (name, fn) => {
    try {
      await fn();
      pass++;
      console.log(`PASS: ${name}`);
    } catch (e) {
      fail++;
      console.log(`FAIL: ${name} — ${e.message}`);
    }
  };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

  const fakeReq = {
    url: 'http://localhost:1/v1/chat/completions',
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-secret' },
    body: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
  };

  await t('happy path returns parsed json', async () => {
    const body = await sendRequest(fakeReq, {
      sendFn: async () => ({ status: 200, json: async () => ({ ok: 1 }) }),
    });
    assert(body.ok === 1, 'body');
  });

  await t('non-2xx status throws with detail', async () => {
    let threw = false;
    try {
      await sendRequest(fakeReq, {
        sendFn: async () => ({ status: 401, json: async () => ({}), text: async () => 'unauthorized' }),
      });
    } catch (e) {
      threw = e instanceof LlmTransportError && /HTTP 401/.test(e.message);
    }
    assert(threw, 'expected HTTP 401 error');
  });

  await t('network error never leaks credentials', async () => {
    let msg = '';
    try {
      await sendRequest(fakeReq, {
        sendFn: async () => { throw new Error('ECONNREFUSED'); },
      });
    } catch (e) { msg = e.message; }
    assert(msg.includes('ECONNREFUSED'), 'root cause surfaced');
    assert(!msg.includes('sk-secret'), 'credential leaked in error message');
    assert(msg.includes('[MASKED]'), 'masked headers missing');
  });

  await t('non-json response body throws', async () => {
    let threw = false;
    try {
      await sendRequest(fakeReq, {
        sendFn: async () => ({ status: 200, json: async () => { throw new Error('bad'); } }),
      });
    } catch (e) {
      threw = /non-JSON/.test(e.message);
    }
    assert(threw, 'expected non-JSON error');
  });

  await t('timeout aborts and reports duration', async () => {
    let threw = false;
    try {
      await sendRequest(fakeReq, {
        timeoutMs: 20,
        sendFn: (url, init) => new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }),
      });
    } catch (e) {
      threw = /timeout after 20ms/.test(e.message);
    }
    assert(threw, 'expected timeout error');
  });

  await t('complete() extracts text via provider mapping', async () => {
    const cfg = { provider: 'openai-compatible', apiKey: null, baseUrl: 'http://localhost:1/v1', model: 'm' };
    const text = await complete(cfg, { prompt: 'hi' }, {
      sendFn: async () => ({
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'answer' } }] }),
      }),
    });
    assert(text === 'answer', 'extracted text');
  });

  await t('complete() with empty content fails loudly', async () => {
    const cfg = { provider: 'openai-compatible', apiKey: null, baseUrl: 'http://localhost:1/v1', model: 'm' };
    let threw = false;
    try {
      await complete(cfg, { prompt: 'hi' }, {
        sendFn: async () => ({ status: 200, json: async () => ({ choices: [] }) }),
      });
    } catch (e) {
      threw = /no text content/.test(e.message);
    }
    assert(threw, 'expected no-text error');
  });

  console.log(`SELF-TEST RESULT: PASS=${pass} FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

import { pathToFileURL } from 'node:url';

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv.includes('--self-test')) {
    selfTest();
  } else {
    console.error('Usage: node llmtransport.js --self-test');
    console.error('This module is loaded dynamically by --llm gated commands only.');
    process.exit(2);
  }
}
