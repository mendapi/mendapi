#!/usr/bin/env node
// mendapi astlite — zero-dependency AST-lite engine for syntax-aware code
// transforms. This is the foundation of the AST-tier fixer track: instead of
// blind regex replacement (which corrupts string literals, comments, and
// template literals containing the target pattern), astlite tokenizes the
// source just enough to know what is *code* and what is not, locates call
// sites by method chain, splits arguments with full nesting awareness, and
// rewrites them structurally.
//
// Scope (deliberate): JavaScript / TypeScript surface syntax. Not a full
// parser — a lexical scanner that classifies every character as code,
// string, template, comment, or regex literal, plus a call-site walker on
// top of the code regions. That is sufficient for the migration-pack use
// cases (method renames, positional-to-named argument moves, argument
// reordering, option-object injection) while staying zero-dependency.
//
// Usage:
//   node app/astlite.js --self-test     run built-in unit tests
//
// Library API (used by fixer packs):
//   maskNonCode(text)                 -> string with non-code chars blanked
//   findCallSites(text, chainRegex)   -> [{ start, calleeEnd, argsStart, argsEnd, args }]
//   splitArgs(text, argsStart, argsEnd) -> [{ start, end, text }]
//   replaceCalls(text, chainRegex, fn)  -> transformed text
//
// No network primitives. No child processes. Pure string analysis.

// ---------- lexical region scanner ----------
// Region kinds (kindMask): 1 = code, 2 = string literal, 3 = template literal
// text (delimiters + text parts; ${ } interpolations are code), 4 = comment,
// 5 = regex literal.
const KIND_CODE = 1;
const KIND_STRING = 2;
const KIND_TEMPLATE = 3;
const KIND_COMMENT = 4;
const KIND_REGEX = 5;

// Returns a Uint8Array the same length as text with a region kind per char.
function kindMask(text) {
  const n = text.length;
  const mask = new Uint8Array(n).fill(KIND_CODE);
  // template nesting stack: tracks brace depth inside ${ } per template level
  const tplStack = [];
  let i = 0;
  let prevSig = ''; // last significant code char (for regex-vs-division)
  let curKind = 0; // kind used by markNon for the current region
  const markNon = (from, to) => { for (let k = from; k < to; k++) mask[k] = curKind; };
  while (i < n) {
    const c = text[i];
    const c2 = i + 1 < n ? text[i + 1] : '';
    // line comment
    if (c === '/' && c2 === '/') {
      curKind = KIND_COMMENT;
      let j = i;
      while (j < n && text[j] !== '\n') j++;
      markNon(i, j);
      i = j;
      continue;
    }
    // block comment
    if (c === '/' && c2 === '*') {
      curKind = KIND_COMMENT;
      let j = i + 2;
      while (j < n && !(text[j] === '*' && text[j + 1] === '/')) j++;
      j = Math.min(n, j + 2);
      markNon(i, j);
      i = j;
      continue;
    }
    // string literals
    if (c === '"' || c === "'") {
      curKind = KIND_STRING;
      let j = i + 1;
      while (j < n && text[j] !== c) {
        if (text[j] === '\\') j++;
        j++;
      }
      j = Math.min(n, j + 1);
      markNon(i, j);
      prevSig = c; // a string is a value: following / is division
      i = j;
      continue;
    }
    // template literal open
    if (c === '`') {
      curKind = KIND_TEMPLATE;
      let j = i + 1;
      markNon(i, i + 1);
      while (j < n) {
        if (text[j] === '\\') { markNon(j, j + 2); j += 2; continue; }
        if (text[j] === '`') { markNon(j, j + 1); j++; break; }
        if (text[j] === '$' && text[j + 1] === '{') {
          // interpolation: keep ${ } contents as code
          markNon(j, j + 2); // the ${ itself is delimiter
          tplStack.push(0);
          j += 2;
          // recursively scan until matching } — delegate to outer loop by
          // rewinding: simplest correct approach is manual brace tracking here
          let depth = 1;
          while (j < n && depth > 0) {
            const d = text[j];
            const d2 = j + 1 < n ? text[j + 1] : '';
            if (d === '/' && d2 === '/') { let k = j; while (k < n && text[k] !== '\n') k++; curKind = KIND_COMMENT; markNon(j, k); curKind = KIND_TEMPLATE; j = k; continue; }
            if (d === '/' && d2 === '*') { let k = j + 2; while (k < n && !(text[k] === '*' && text[k + 1] === '/')) k++; k = Math.min(n, k + 2); curKind = KIND_COMMENT; markNon(j, k); curKind = KIND_TEMPLATE; j = k; continue; }
            if (d === '"' || d === "'") { let k = j + 1; while (k < n && text[k] !== d) { if (text[k] === '\\') k++; k++; } k = Math.min(n, k + 1); curKind = KIND_STRING; markNon(j, k); curKind = KIND_TEMPLATE; j = k; continue; }
            if (d === '`') {
              // nested template: mark whole nested template non-code except
              // its own interpolations — for fixer purposes treating nested
              // template interpolations as non-code is acceptable (conservative:
              // we never rewrite inside them).
              let k = j + 1;
              while (k < n) {
                if (text[k] === '\\') { k += 2; continue; }
                if (text[k] === '`') { k++; break; }
                k++;
              }
              markNon(j, k);
              j = k;
              continue;
            }
            if (d === '{') depth++;
            if (d === '}') { depth--; if (depth === 0) { markNon(j, j + 1); j++; break; } }
            j++;
          }
          tplStack.pop();
          continue;
        }
        markNon(j, j + 1);
        j++;
      }
      prevSig = '`';
      i = j;
      continue;
    }
    // regex literal vs division: / starts a regex when previous significant
    // char is not a value terminator
    if (c === '/') {
      const valueEnd = /[\w$)\]`'"]/.test(prevSig);
      if (!valueEnd) {
        curKind = KIND_REGEX;
        let j = i + 1;
        let inClass = false;
        while (j < n) {
          const d = text[j];
          if (d === '\\') { j += 2; continue; }
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) { j++; break; }
          else if (d === '\n') break; // unterminated — bail
          j++;
        }
        // trailing flags
        while (j < n && /[a-z]/i.test(text[j])) j++;
        markNon(i, j);
        prevSig = '/';
        i = j;
        continue;
      }
    }
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  return mask;
}

// Back-compat: 1 = code, 0 = non-code (any literal/comment region).
function codeMask(text) {
  const km = kindMask(text);
  const mask = new Uint8Array(km.length);
  for (let i = 0; i < km.length; i++) mask[i] = km[i] === KIND_CODE ? 1 : 0;
  return mask;
}

// Return text with every non-code character replaced by a space (delimiters
// too), preserving offsets — regexes run on the masked text can only match
// real code.
function maskNonCode(text) {
  const mask = codeMask(text);
  let out = '';
  for (let i = 0; i < text.length; i++) out += mask[i] ? text[i] : (text[i] === '\n' ? '\n' : ' ');
  return out;
}

// ---------- argument splitting ----------
// Given the offsets of the ( and ) of a call, split top-level arguments.
function splitArgs(text, argsStart, argsEnd) {
  const mask = codeMask(text);
  const args = [];
  let depth = 0;
  let cur = argsStart + 1;
  for (let i = argsStart + 1; i < argsEnd; i++) {
    if (!mask[i]) continue;
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      args.push({ start: cur, end: i, text: text.slice(cur, i).trim() });
      cur = i + 1;
    }
  }
  if (argsEnd > cur && text.slice(cur, argsEnd).trim() !== '') {
    args.push({ start: cur, end: argsEnd, text: text.slice(cur, argsEnd).trim() });
  }
  return args;
}

// Find the matching ) for the ( at openIdx, honoring nesting and non-code.
function matchParen(text, mask, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (!mask[i]) continue;
    if (text[i] === '(') depth++;
    else if (text[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// ---------- call-site location ----------
// chainRegex matches the callee expression ending right before the opening
// paren, e.g. /\.createChatCompletion$/ applied per candidate. For practical
// pack use, pass a regex WITHOUT anchors that matches the chain, e.g.
// /\bopenai\.chat\.completions\.create/ or /\.createChatCompletion\b/.
function findCallSites(text, chainRegex) {
  const masked = maskNonCode(text);
  const mask = codeMask(text);
  const sites = [];
  const re = new RegExp(chainRegex.source, chainRegex.flags.includes('g') ? chainRegex.flags : chainRegex.flags + 'g');
  let m;
  while ((m = re.exec(masked)) !== null) {
    const calleeEnd = m.index + m[0].length;
    // skip whitespace to find the (
    let p = calleeEnd;
    while (p < text.length && /\s/.test(text[p])) p++;
    if (text[p] !== '(') continue; // property access, not a call
    const close = matchParen(text, mask, p);
    if (close === -1) continue;
    sites.push({
      start: m.index,
      calleeEnd,
      callee: text.slice(m.index, calleeEnd),
      argsStart: p,
      argsEnd: close,
      args: splitArgs(text, p, close),
    });
    re.lastIndex = close;
  }
  return sites;
}

// ---------- structural rewrite ----------
// fn(site, text) returns either null (leave untouched) or the full
// replacement string for text[site.start .. site.argsEnd+1).
function replaceCalls(text, chainRegex, fn) {
  const sites = findCallSites(text, chainRegex);
  let out = text;
  // apply from last to first so offsets stay valid
  for (let i = sites.length - 1; i >= 0; i--) {
    const s = sites[i];
    const rep = fn(s, out);
    if (rep == null) continue;
    out = out.slice(0, s.start) + rep + out.slice(s.argsEnd + 1);
  }
  return out;
}

// Convenience: rename a callee (method chain) without touching args.
function renameCall(text, chainRegex, newCallee) {
  return replaceCalls(text, chainRegex, (s, cur) =>
    newCallee + cur.slice(s.calleeEnd, s.argsEnd + 1));
}

// ---------- identifier rename ----------
// Rename a bare identifier (type name, class name, imported symbol) in CODE
// regions only. Unlike renameCall this does not require a call site: it
// covers type annotations, import specifiers, extends clauses, generics.
// Matches whole identifiers (\b anchored) and never fires when the match is
// preceded by '.' (member access on another object) or followed/preceded by
// identifier characters. By default comments are treated as non-code (JSDoc
// type references in comments stay untouched unless opts.includeComments).
// opts.includeJsdoc allows matches inside /** ... */ doc comments only —
// JSDoc type annotations are live type information in JS codebases, while
// plain // and /* */ prose comments stay protected.
function renameIdentifier(text, oldName, newName, opts = {}) {
  if (!/^[A-Za-z_$][\w$]*$/.test(oldName)) throw new Error(`renameIdentifier: invalid identifier ${JSON.stringify(oldName)}`);
  const km = kindMask(text);
  const allowed = new Set([KIND_CODE]);
  if (opts.includeComments) allowed.add(KIND_COMMENT);
  const isJsdocAt = (idx) => {
    // walk back to the start of the enclosing comment region
    let s = idx;
    while (s > 0 && km[s - 1] === KIND_COMMENT) s--;
    return text.startsWith('/**', s);
  };
  const re = new RegExp(`(^|[^\\w$])(${oldName.replace(/\$/g, '\\$')})(?![\\w$])`, 'g');
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const idStart = m.index + m[1].length;
    // '.'-preceded = member access on another object: skip in code, but
    // allow inside JSDoc where import('pkg').Type is a qualified type ref.
    const dotPreceded = m[1] === '.';
    if (dotPreceded && !(opts.includeJsdoc && km[idStart] === KIND_COMMENT && isJsdocAt(idStart))) continue;
    // every char of the identifier must sit in an allowed region
    let ok = true;
    for (let k = idStart; k < idStart + oldName.length; k++) {
      if (allowed.has(km[k])) continue;
      if (opts.includeJsdoc && km[k] === KIND_COMMENT && isJsdocAt(k)) continue;
      ok = false; break;
    }
    if (!ok) continue;
    out += text.slice(last, idStart) + newName;
    last = idStart + oldName.length;
  }
  out += text.slice(last);
  return out;
}

// ---------- destructuring pattern cleanup ----------
// Remove one property from flat object destructuring declarations, e.g.
//   const { iin, brand } = customer.default_source;   ->   const { brand } = customer.default_source;
// This is the AST-tier counterpart of the conservative line-level packs that
// deliberately leave destructuring patterns alone (a dropped binding would
// turn downstream reads into ReferenceErrors). Safety rules, all honest-skip:
//   * only flat patterns (no nested braces) are touched
//   * entries with defaults (`iin = x`) or rest (`...r`) leave the site alone
//   * the bound identifier must have ZERO other references in code regions
//     (string literals, comments, template text never count; `obj.iin`
//     member access never counts; any ambiguous hit counts as a reference,
//     the conservative direction)
//   * when the pattern empties: the declaration is dropped only if the RHS
//     is a pure member/identifier chain (no call parens = no side effects);
//     otherwise it is kept as `const {} = rhs;` (valid JS, side effects kept)
function removeDestructuredProperty(text, propName) {
  if (!/^[A-Za-z_$][\w$]*$/.test(propName)) throw new Error(`removeDestructuredProperty: invalid identifier ${JSON.stringify(propName)}`);
  const masked = maskNonCode(text);
  const km = kindMask(text);
  const declRe = /\b(const|let|var)\s*\{([^{}]*)\}\s*=/g;
  const edits = []; // { start, end, replacement }
  let m;
  while ((m = declRe.exec(masked)) !== null) {
    const braceOpen = masked.indexOf('{', m.index);
    const braceClose = masked.indexOf('}', braceOpen);
    const inner = text.slice(braceOpen + 1, braceClose);
    // parse flat entries from the real text (offsets equal the masked text)
    const rawEntries = inner.split(',').map((e) => e.trim()).filter((e) => e !== '');
    let hitIdx = -1;
    let bound = null;
    for (let i = 0; i < rawEntries.length; i++) {
      const e = rawEntries[i];
      if (e === propName) { hitIdx = i; bound = propName; break; }
      const am = e.match(/^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)$/);
      if (am && am[1] === propName) { hitIdx = i; bound = am[2]; break; }
    }
    if (hitIdx === -1) continue; // property not in this pattern
    // honest skips: defaults or rest anywhere in the pattern make comma
    // surgery risky; leave the whole site to a human / full parser
    if (rawEntries.some((e) => e.includes('=') || e.startsWith('...'))) continue;
    // reference counting: the bound identifier must appear nowhere else in
    // code regions (member access `.bound` excluded; everything else counts)
    const refRe = new RegExp(`(^|[^\\w$])(${bound.replace(/\$/g, '\\$')})(?![\\w$])`, 'g');
    let referenced = false;
    let rm;
    while ((rm = refRe.exec(text)) !== null) {
      const idStart = rm.index + rm[1].length;
      if (idStart > braceOpen && idStart < braceClose) continue; // the pattern itself
      if (km[idStart] !== KIND_CODE) continue; // strings/comments/templates never count
      if (rm[1] === '.') continue; // member access on another object
      referenced = true; break;
    }
    if (referenced) continue;
    const kept = rawEntries.filter((_, i) => i !== hitIdx);
    if (kept.length > 0) {
      edits.push({ start: braceOpen, end: braceClose + 1, replacement: `{ ${kept.join(', ')} }` });
      continue;
    }
    // pattern emptied: locate the statement end (first code-region `;` or
    // newline after the `=`) and decide whether the RHS is side-effect free
    const eq = masked.indexOf('=', braceClose);
    let stmtEnd = -1;
    for (let i = eq + 1; i < text.length; i++) {
      if (km[i] === KIND_CODE && text[i] === ';') { stmtEnd = i + 1; break; }
      if (text[i] === '\n' && km[i] !== KIND_STRING && km[i] !== KIND_TEMPLATE) { stmtEnd = i; break; }
    }
    if (stmtEnd === -1) stmtEnd = text.length;
    const rhs = text.slice(eq + 1, stmtEnd).replace(/;\s*$/, '').trim();
    if (/^[\w$?.\[\]\s]+$/.test(rhs) && !rhs.includes('(')) {
      // pure member/identifier chain: drop the whole declaration; also eat
      // the leading indentation and the trailing newline so no blank line
      // is left behind
      let lineStart = m.index;
      while (lineStart > 0 && text[lineStart - 1] !== '\n') lineStart--;
      const before = text.slice(lineStart, m.index);
      const start = /^[ \t]*$/.test(before) ? lineStart : m.index;
      let end = stmtEnd;
      if (start === lineStart && text[end] === '\n') end++;
      edits.push({ start, end, replacement: '' });
    } else {
      edits.push({ start: braceOpen, end: braceClose + 1, replacement: '{}' });
    }
  }
  let out = text;
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i];
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  }
  return out;
}

export { codeMask, kindMask, maskNonCode, splitArgs, findCallSites, replaceCalls, renameCall, renameIdentifier, removeDestructuredProperty };

// ---------- self-test ----------
function selfTest() {
  const results = [];
  const t = (name, cond) => results.push({ name, pass: !!cond });

  // 1. regex-vs-astlite discriminator: pattern inside a string literal must
  //    NOT be rewritten (this is the exact failure mode of blind regex packs)
  {
    const src = `const msg = "call openai.createChatCompletion( here";\nawait client.createChatCompletion({ model: "gpt-4" });\n`;
    const out = renameCall(src, /\bclient\.createChatCompletion\b/, 'client.chat.completions.create');
    t('rename rewrites real call', out.includes('client.chat.completions.create({ model: "gpt-4" })'));
    t('rename leaves string literal intact', out.includes('"call openai.createChatCompletion( here"'));
    // control: prove the naive regex WOULD have corrupted the string
    const naive = src.replace(/createChatCompletion/g, 'chat.completions.create');
    t('control: naive regex corrupts string literal', naive.includes('"call openai.chat.completions.create( here"'));
  }

  // 2. pattern inside comments must not be rewritten
  {
    const src = `// migrate client.oldCall() later\n/* client.oldCall(1) */\nclient.oldCall(1);\n`;
    const out = renameCall(src, /\bclient\.oldCall\b/, 'client.newCall');
    t('comments untouched', out.includes('// migrate client.oldCall() later') && out.includes('/* client.oldCall(1) */'));
    t('code rewritten once', (out.match(/client\.newCall\(1\)/g) || []).length === 1);
  }

  // 3. template literal: text part non-code, interpolation IS code
  {
    const src = 'const s = `use client.oldCall() like ${client.oldCall(x)} ok`;\n';
    const out = renameCall(src, /\bclient\.oldCall\b/, 'client.newCall');
    t('template text part untouched', out.includes('use client.oldCall() like'));
    t('template interpolation rewritten', out.includes('${client.newCall(x)}'));
  }

  // 4. nested-paren argument splitting
  {
    const src = 'api.doThing(fn(a, b), { x: [1, 2], y: g(h(3), 4) }, "lit,eral");';
    const sites = findCallSites(src, /\bapi\.doThing\b/);
    t('one call site found', sites.length === 1);
    const args = sites[0] ? sites[0].args.map(a => a.text) : [];
    t('three top-level args', args.length === 3);
    t('nested call arg intact', args[0] === 'fn(a, b)');
    t('object arg intact', args[1] === '{ x: [1, 2], y: g(h(3), 4) }');
    t('string arg with comma intact', args[2] === '"lit,eral"');
  }

  // 5. positional-to-named transform (cloudflare v7 named-path-params shape)
  {
    const src = 'await cf.zones.dns.get(zoneId, recordId, { timeout: 5 });';
    const out = replaceCalls(src, /\bcf\.zones\.dns\.get\b/, (s) => {
      if (s.args.length < 2) return null;
      const [zone, rec, ...rest] = s.args.map(a => a.text);
      const opts = rest.length ? `, ${rest.join(', ')}` : '';
      return `cf.zones.dns.get(${rec}, { zone_id: ${zone} }${opts})`;
    });
    t('positional-to-named rewrite', out === 'await cf.zones.dns.get(recordId, { zone_id: zoneId }, { timeout: 5 });');
  }

  // 6. multiple call sites in one file, rewritten independently
  {
    const src = 'a.old(1);\nconst r = /a\\.old\\(/g;\na.old(2);\n';
    const out = renameCall(src, /\ba\.old\b/, 'a.neo');
    t('regex literal untouched', out.includes('/a\\.old\\(/g'));
    t('both real calls rewritten', out.includes('a.neo(1)') && out.includes('a.neo(2)'));
  }

  // 7. property access without call is not treated as a call site
  {
    const src = 'const ref = client.oldCall;\nclient.oldCall(9);\n';
    const sites = findCallSites(src, /\bclient\.oldCall\b/);
    t('bare property access skipped', sites.length === 1 && sites[0].args[0].text === '9');
  }

  // 8. division is not misread as regex (mask sanity)
  {
    const src = 'const x = a / b; client.oldCall(x / 2);\n';
    const out = renameCall(src, /\bclient\.oldCall\b/, 'client.newCall');
    t('division-safe', out.includes('client.newCall(x / 2)'));
  }

  // 9. renameIdentifier: type/class names in code rewritten, strings and
  //    prose comments untouched, member access on other objects untouched
  {
    const src = [
      "import { DEXTestGetResponse } from 'cloudflare';",
      'const note = "DEXTestGetResponse is gone in v7";',
      '// prose: DEXTestGetResponse mentioned in a comment',
      'let r = other.DEXTestGetResponse;',
      '/** @returns {Promise<DEXTestGetResponse>} */',
      'function f() { return /** */ null; }',
      'const x = new DEXTestGetResponse();',
      'const tpl = `mentions DEXTestGetResponse in text ${DEXTestGetResponse.kind}`;',
    ].join('\n');
    const out = renameIdentifier(src, 'DEXTestGetResponse', 'SchemaHTTP', { includeJsdoc: true });
    t('identifier: import specifier rewritten', out.includes("import { SchemaHTTP } from 'cloudflare';"));
    t('identifier: string literal untouched', out.includes('"DEXTestGetResponse is gone in v7"'));
    t('identifier: prose comment untouched', out.includes('// prose: DEXTestGetResponse mentioned'));
    t('identifier: member access on other object untouched', out.includes('other.DEXTestGetResponse'));
    t('identifier: jsdoc type rewritten with includeJsdoc', out.includes('{Promise<SchemaHTTP>}'));
    t('identifier: new expression rewritten', out.includes('new SchemaHTTP()'));
    t('identifier: template text untouched, interpolation rewritten', out.includes('mentions DEXTestGetResponse in text ${SchemaHTTP.kind}'));
    // control: naive regex corrupts string + prose comment + member access
    const naive = src.replace(/\bDEXTestGetResponse\b/g, 'SchemaHTTP');
    t('control: naive regex corrupts string literal', naive.includes('"SchemaHTTP is gone in v7"'));
    t('control: naive regex corrupts member access', naive.includes('other.SchemaHTTP'));
  }

  // 10. renameIdentifier: partial-name and adjacency safety
  {
    const src = 'const DEXTestGetResponseList = 1; call(DEXTestGetResponse);\n';
    const out = renameIdentifier(src, 'DEXTestGetResponse', 'SchemaHTTP');
    t('identifier: longer identifier not clipped', out.includes('DEXTestGetResponseList = 1'));
    t('identifier: exact match rewritten', out.includes('call(SchemaHTTP)'));
    t('identifier: idempotent', renameIdentifier(out, 'DEXTestGetResponse', 'SchemaHTTP') === out);
  }

  // 11. removeDestructuredProperty: the AST-track destructuring cleanup
  {
    // unreferenced binding is removed, siblings kept
    const src = 'const { iin, brand } = customer.default_source;\nreturn brand;\n';
    const out = removeDestructuredProperty(src, 'iin');
    t('destructure: unreferenced binding removed', out.includes('const { brand } = customer.default_source;'));
    t('destructure: sibling reference intact', out.includes('return brand;'));
  }
  {
    // referenced binding => honest skip (conservative direction)
    const src = 'const { iin, brand } = customer.default_source;\nreturn { iin, brand };\n';
    const out = removeDestructuredProperty(src, 'iin');
    t('destructure: referenced binding untouched', out === src);
  }
  {
    // renamed entry ({ iin: bin }): reference check follows the LOCAL name
    const used = 'const { iin: bin, brand } = card;\nconsole.log(bin);\n';
    t('destructure: renamed binding referenced -> untouched', removeDestructuredProperty(used, 'iin') === used);
    const unused = 'const { iin: bin, brand } = card;\nconsole.log(brand);\n';
    t('destructure: renamed binding unreferenced -> removed', removeDestructuredProperty(unused, 'iin').includes('const { brand } = card;'));
  }
  {
    // string/comment/member-access mentions never count as references
    const src = 'const { iin, brand } = card;\n// iin was the BIN\nconst s = "iin";\nconst other = record.iin;\nreturn brand;\n';
    const out = removeDestructuredProperty(src, 'iin');
    t('destructure: string/comment/member mentions do not block removal', out.includes('const { brand } = card;'));
    t('destructure: comment and string survive verbatim', out.includes('// iin was the BIN') && out.includes('"iin"') && out.includes('record.iin'));
  }
  {
    // defaults and rest elements => honest skip
    const d = 'const { iin = null, brand } = card;\nreturn brand;\n';
    t('destructure: default value pattern untouched', removeDestructuredProperty(d, 'iin') === d);
    const r = 'const { iin, ...rest } = card;\nreturn rest;\n';
    t('destructure: rest pattern untouched', removeDestructuredProperty(r, 'iin') === r);
  }
  {
    // nested patterns => honest skip (flat-only rule)
    const src = 'const { card: { iin } } = charge;\nreturn 1;\n';
    t('destructure: nested pattern untouched', removeDestructuredProperty(src, 'iin') === src);
  }
  {
    // pattern empties: pure member RHS => whole declaration dropped
    const src = 'function f(card) {\n  const { iin } = card.details;\n  return card.brand;\n}\n';
    const out = removeDestructuredProperty(src, 'iin');
    t('destructure: emptied pattern with pure RHS drops declaration', !out.includes('iin') && !out.includes('{}'));
    t('destructure: no blank line left behind', out === 'function f(card) {\n  return card.brand;\n}\n');
  }
  {
    // pattern empties: call RHS has side effects => kept as `const {} = rhs`
    const src = 'const { iin } = await fetchCard(id);\nreturn 1;\n';
    const out = removeDestructuredProperty(src, 'iin');
    t('destructure: emptied pattern with call RHS keeps side effect', out.includes('const {} = await fetchCard(id);'));
  }
  {
    // patterns inside strings/comments are never rewritten
    const src = 'const s = "const { iin } = card;";\n// const { iin } = card;\nconst { iin, brand } = card;\nuse(brand);\n';
    const out = removeDestructuredProperty(src, 'iin');
    t('destructure: string literal pattern untouched', out.includes('"const { iin } = card;"'));
    t('destructure: comment pattern untouched', out.includes('// const { iin } = card;'));
    t('destructure: real code pattern rewritten', out.includes('const { brand } = card;'));
    // control: prove a naive regex WOULD have hit the string literal too
    const naive = src.replace(/\biin\s*,\s*/g, '').replace(/\{\s*iin\s*\}/g, '{}');
    t('control: naive regex corrupts string pattern', naive.includes('"const {} = card;"'));
  }
  {
    // idempotent
    const src = 'const { iin, brand } = card;\nuse(brand);\n';
    const once = removeDestructuredProperty(src, 'iin');
    t('destructure: idempotent', removeDestructuredProperty(once, 'iin') === once);
  }

  const fails = results.filter(r => !r.pass);
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}: ${r.name}`);
  console.log(`astlite self-test: ${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
}

if (process.argv[1] && process.argv[1].endsWith('astlite.js')) {
  if (process.argv.includes('--self-test')) selfTest();
  else {
    console.log('Usage: node app/astlite.js --self-test');
    process.exit(1);
  }
}
