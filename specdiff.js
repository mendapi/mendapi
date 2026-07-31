#!/usr/bin/env node
// mendapi specdiff — deterministic OpenAPI spec diff engine.
// Zero npm dependencies: node:fs only. Zero network — reads local files.
//
// This is the Change Intelligence endgame foundation (GOAL track d): instead
// of trusting upstream changelog prose, diff two versions of an OpenAPI spec
// and emit structured, evidence-backed change records anchored to the API
// surface itself (path / method / parameter / property / enum value).
//
// Detected change kinds (each record carries a JSON-pointer-style anchor):
//   path-removed            breaking   whole path gone
//   path-added              additive
//   operation-removed       breaking   method gone from an existing path
//   operation-added         additive
//   param-removed           breaking   callers may still send it / rely on it
//   param-added-required    breaking   existing calls now rejected
//   param-added-optional    additive
//   param-now-required      breaking   optional -> required flip
//   param-enum-value-removed breaking  an enum value was removed from a
//                                      parameter surface (schema / array
//                                      items / item property): senders of
//                                      the value get rejected. Value added
//                                      widens = silent; union-derived enum
//                                      evidence = silent.
//   param-became-enum       breaking   a typed enum-free parameter gained a
//                                      finite value set: every value outside
//                                      it now rejected. Old side must be a
//                                      plain typed schema (union / untyped =
//                                      silent); enum removal widens = silent.
//   request-prop-removed    breaking   senders of the property break
//   request-prop-added-required breaking
//   request-prop-added      additive
//   response-prop-removed   breaking   readers of the property break
//   response-prop-added     additive
//   enum-value-removed      breaking   senders of the value get rejected
//   enum-value-added        additive   exhaustive readers need a new branch
//                                      (mendable: mirror-existing-branch packs)
//   request-prop-type-changed   breaking   senders now send the wrong type
//   response-prop-type-changed  breaking   readers now parse the wrong type
//   response-prop-became-nullable   breaking   readers may not handle null
//   request-prop-became-not-nullable breaking  senders of null get rejected
//   response-status-removed  breaking  a 2xx status disappeared: callers
//                                      branching on it stop matching. 4xx/5xx
//                                      churn is deliberately silent.
//   response-body-type-changed breaking a 2xx response body's ROOT type was
//                                      replaced (e.g. number -> object): the
//                                      prop-level diff is blind to scalar
//                                      roots (empty prop map) but every
//                                      reader of the old shape breaks.
//                                      Known-to-known concrete root types
//                                      only; union/untyped roots and
//                                      annotation back-fill stay silent.
//   param-type-narrowed      breaking   a parameter's accepted JSON type set
//                                       shrank (e.g. oneOf[string,boolean] ->
//                                       string): senders of the dropped type
//                                       now get rejected. Widening (types
//                                       added) and unknown/unresolvable sides
//                                       are deliberately silent.
//   param-type-changed       breaking   a parameter's accepted JSON type set
//                                       was replaced wholesale (disjoint old
//                                       vs new, e.g. string -> array): every
//                                       existing caller's value now rejected.
//                                       Overlapping sets go to the narrowing/
//                                       widening lanes; unknown sides silent.
//   request-prop-pattern-added  breaking   a pattern constraint appeared on a
//                                      request prop that had none: previously
//                                      valid values now get rejected. Pattern
//                                      rewrites and response-side pattern
//                                      churn are deliberately silent.
//   response-prop-became-optional   warning    field may now be absent; most
//                                              defensive readers are unaffected,
//                                              so this is graded warning (not
//                                              breaking) to honor the
//                                              false-positive-rate-first rule.
//                                              Records carry warning:true.
//
// Deliberately NOT reported: format-only churn (same JSON type, different
// `format` annotation, e.g. uri -> none). Spec generators flip formats
// constantly without any wire-level semantic change; flagging them as
// breaking would violate the false-positive-rate-first rule.
//
// Design rules:
//   - Deterministic only. No LLM in this layer; semantics stay explainable.
//   - Local $ref resolution (components/*) with cycle guard; property paths
//     flattened to a bounded depth so evidence stays readable.
//   - Conservative: anything the walker cannot resolve is skipped silently
//     rather than guessed at (precision over coverage).
//
// Usage:
//   node app/specdiff.js <old-spec.json> <new-spec.json> [--json <out.json>]
// Exit codes: 0 = diff produced (possibly empty), 1 = usage/parse error.

import { readFileSync, writeFileSync } from 'node:fs';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const MAX_PROP_DEPTH = 3;
// Deep-scan cap for the request-side tightening pass (see
// diffDeepRequestTightenings): deep enough to reach real-world nesting
// (PayPal billing subscriber card fields sit at depth 4-6), bounded so
// pathological/recursive schemas cannot blow up (cycle guard also applies).
const DEEP_PROP_DEPTH = 8;

// ---------- $ref resolution ----------

function resolveRef(spec, ref, seen) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  if (seen.has(ref)) return null; // cycle guard
  seen.add(ref);
  let node = spec;
  for (const part of ref.slice(2).split('/')) {
    if (node == null || typeof node !== 'object') return null;
    node = node[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return node ?? null;
}

function deref(spec, schema, seen = new Set()) {
  if (schema == null || typeof schema !== 'object') return schema;
  if (schema.$ref) {
    const target = resolveRef(spec, schema.$ref, seen);
    return target ? deref(spec, target, seen) : null;
  }
  return schema;
}

// Flatten a schema's properties into dot paths (bounded depth).
// Returns Map<propPath, {required: bool, enum: string[]|null, type: string|null, nullable: bool|null}>.
function flattenProps(spec, schema, prefix = '', depth = 0, seen = new Set(), out = new Map(), maxDepth = MAX_PROP_DEPTH) {
  const s = deref(spec, schema, seen);
  if (!s || typeof s !== 'object' || depth > maxDepth) return out;

  // Unwrap arrays: diff the item shape under the same path with [] marker.
  if (s.type === 'array' && s.items) {
    const itemPath = prefix ? `${prefix}[]` : '[]';
    // Record the item's OWN root type at the [] path so scalar -> object
    // (or any concrete root type) replacements of array items are visible
    // to the type comparison in diffPropMaps. Without this entry a scalar
    // item produces NO map rows at all (no properties to flatten), so an
    // item root flip like string -> object is a structural blindspot --
    // the array-item analogue of the scalar response body root gap closed
    // by response-body-type-changed. Fail-closed: normalizeType returns
    // null for untyped/union items (silent), and only the type field is
    // carried (everything else unknown), so no other comparison can ever
    // fire from this entry. Reference case: cloudflare b61f904f->7abe8850
    // workers dispatch_namespace binding outbound.params items string ->
    // object (oasdiff request-property-type-changed on params/items/).
    if (!out.has(itemPath)) {
      const item = deref(spec, s.items, new Set(seen));
      const { type: itemType } = normalizeType(item);
      if (itemType) {
        out.set(itemPath, {
          required: false, enum: null, type: itemType, nullable: null,
          pattern: null, maxLength: null, maxItems: null, minItems: null,
          itemRoot: true,
        });
      }
    }
    return flattenProps(spec, s.items, itemPath, depth, seen, out, maxDepth);
  }
  // Merge allOf conservatively (union of members' properties).
  if (Array.isArray(s.allOf)) {
    for (const member of s.allOf) flattenProps(spec, member, prefix, depth, seen, out, maxDepth);
  }
  // Descend oneOf/anyOf unions: a property present in ANY branch is part of the
  // API surface, so it must not be reported as removed when a generator wraps
  // the schema in a union (false-positive killer). Required flags across union
  // branches are unreliable (a prop may be optional-or-absent in sibling
  // branches), so properties discovered through a union are marked
  // required=false unless every branch that defines them requires them.
  const unionBranches = [];
  for (const kw of ['oneOf', 'anyOf']) {
    if (!Array.isArray(s[kw])) continue;
    for (const member of s[kw]) {
      unionBranches.push(flattenProps(spec, member, prefix, depth, new Set(seen), new Map(), maxDepth));
    }
  }
  if (unionBranches.length > 0) {
    // Merge branch maps. A prop counts as required only when it is present
    // AND required in every branch: a prop required inside just one branch
    // (e.g. a newly added union alternative) is conditionally required for
    // callers who pick that branch -- reporting it as a hard requirement
    // fabricates breaking changes. Enums merge as the UNION of values: a
    // value accepted by any branch is accepted on the wire, so narrowing in
    // one branch while another keeps (or drops) the constraint must never
    // surface as enum-value-removed. When any branch leaves the prop
    // unconstrained, the effective constraint is none (enum=null).
    const merged = new Map();
    for (const branch of unionBranches) {
      for (const [path, meta] of branch) {
        if (!merged.has(path)) {
          merged.set(path, { ...meta, branches: 1 });
        } else {
          const prev = merged.get(path);
          merged.set(path, {
            required: prev.required && meta.required,
            enum: prev.enum && meta.enum ? [...new Set([...prev.enum, ...meta.enum])] : null,
            type: prev.type === meta.type ? prev.type : null,
            nullable: prev.nullable === meta.nullable ? prev.nullable : null,
            // Pattern across union branches is unreliable evidence (a value
            // may satisfy a sibling branch with no pattern): drop to unknown
            // unless every branch agrees on the same pattern.
            pattern: prev.pattern === meta.pattern ? prev.pattern : null,
            branches: prev.branches + 1,
          });
        }
      }
    }
    for (const [path, meta] of merged) {
      const viaUnion = {
        required: meta.required && meta.branches === unionBranches.length,
        enum: meta.branches === unionBranches.length ? meta.enum : null,
        type: meta.type,
        nullable: meta.nullable,
        pattern: meta.branches === unionBranches.length ? (meta.pattern ?? null) : null,
        viaUnion: true,
      };
      if (out.has(path)) {
        const prev = out.get(path);
        out.set(path, {
          required: prev.required && viaUnion.required,
          enum: prev.enum && viaUnion.enum ? [...new Set([...prev.enum, ...viaUnion.enum])] : null,
          type: prev.type === viaUnion.type ? prev.type : null,
          nullable: prev.nullable === viaUnion.nullable ? prev.nullable : null,
          pattern: prev.pattern === viaUnion.pattern ? (prev.pattern ?? null) : null,
          viaUnion: true,
        });
      } else {
        out.set(path, viaUnion);
      }
    }
  }
  // Parent-level `required` must reach props contributed by allOf members
  // (and union branches): JSON Schema applies `required` at the level it is
  // declared, regardless of where the property definition itself lives.
  // Without this back-fill, a generator restructuring flat properties into
  // allOf branches while KEEPING the parent required list fabricates
  // became-optional warnings, and a genuinely new parent-required prop whose
  // definition sits in an allOf member gets downgraded to non-breaking
  // prop-added (PayPal checkout_orders `items/op`; oasdiff
  // new-required-request-property). Loop 378 adjudication.
  if (Array.isArray(s.required)) {
    for (const name of s.required) {
      const rPath = prefix ? `${prefix}.${name}` : name;
      const existing = out.get(rPath);
      if (existing && !existing.required) out.set(rPath, { ...existing, required: true });
    }
  }
  const props = s.properties;
  if (!props || typeof props !== 'object') return out;
  const required = new Set(Array.isArray(s.required) ? s.required : []);
  for (const [name, sub] of Object.entries(props)) {
    const path = prefix ? `${prefix}.${name}` : name;
    const subResolved = deref(spec, sub, new Set(seen));
    const enumVals = subResolved && Array.isArray(subResolved.enum)
      ? subResolved.enum.map(String)
      : null;
    const { type, nullable } = normalizeType(subResolved);
    const pattern = subResolved && typeof subResolved.pattern === 'string'
      ? subResolved.pattern
      : null;
    // maxLength is carried only when explicitly declared: absent = unknown
    // (never inferred as "unbounded" -- see the back-fill adjudication on
    // param bounds, Loop 380). Loop 397.
    const maxLength = subResolved && typeof subResolved.maxLength === 'number'
      ? subResolved.maxLength
      : null;
    // maxItems: same explicit-only rule. Captured on the array node itself
    // (before item unwrapping) so array-shaped properties carry their own
    // cardinality bound. Loop 399.
    const maxItems = subResolved && typeof subResolved.maxItems === 'number'
      ? subResolved.maxItems
      : null;
    // minItems: explicit-only capture, like maxItems. Absent stays null
    // (unknown), but see the firing rule in diffPropMaps: unlike absent
    // minLength (vacuous "0" back-fill, adjudicated silent), an INTRODUCED
    // minItems >= 1 is never vacuous -- it always rejects the empty array.
    const minItems = subResolved && typeof subResolved.minItems === 'number'
      ? subResolved.minItems
      : null;
    out.set(path, { required: required.has(name), enum: enumVals, type, nullable, pattern, maxLength, maxItems, minItems, reqView: objectRequiredView(spec, sub), strView: stringDomainView(spec, sub) });
    if (depth < maxDepth) flattenProps(spec, sub, path, depth + 1, new Set(seen), out, maxDepth);
  }
  return out;
}

// Required-contract view of an object-shaped schema node, for the
// union-required tightening comparison in diffPropMaps. Two mutually
// exclusive evidence shapes:
//   - plainRequired: string[] -- the node is a PLAIN object (no oneOf/anyOf
//     anywhere at the top level, allOf members merged conjunctively), and
//     this is its effective required list. [] is real evidence ("nothing
//     required") -- an object with no required list accepts the empty
//     payload.
//   - branchRequired: string[][] -- the node is a union (directly, or an
//     allOf wrapping exactly ONE oneOf/anyOf member), one required list per
//     branch, each merged with the conjunctive base required of sibling
//     allOf members (allOf = all must hold).
// Everything ambiguous resolves to { null, null } = unknown = the diff
// layer stays silent (fail-closed): two unions inside one allOf, nested
// unions inside a branch, unresolvable $refs, non-object nodes.
function objectRequiredView(spec, schema) {
  const none = { plainRequired: null, branchRequired: null };
  const s = deref(spec, schema, new Set());
  if (!s || typeof s !== 'object') return none;
  let unionMembers = Array.isArray(s.oneOf) ? s.oneOf
    : Array.isArray(s.anyOf) ? s.anyOf : null;
  const base = [];
  if (Array.isArray(s.allOf)) {
    for (const raw of s.allOf) {
      const m = deref(spec, raw, new Set());
      if (!m || typeof m !== 'object') return none;
      const mu = Array.isArray(m.oneOf) ? m.oneOf
        : Array.isArray(m.anyOf) ? m.anyOf : null;
      if (mu) {
        if (unionMembers) return none; // two unions conjoined: unknown
        unionMembers = mu;
      } else if (Array.isArray(m.required)) {
        base.push(...m.required.map(String));
      }
    }
  }
  if (Array.isArray(s.required)) base.push(...s.required.map(String));
  if (unionMembers) {
    const branchRequired = [];
    for (const raw of unionMembers) {
      const b = deref(spec, raw, new Set());
      if (!b || typeof b !== 'object') return none;
      if (Array.isArray(b.oneOf) || Array.isArray(b.anyOf)) return none; // nested union: unknown
      const req = Array.isArray(b.required) ? b.required.map(String) : [];
      branchRequired.push([...new Set([...base, ...req])]);
    }
    return branchRequired.length ? { plainRequired: null, branchRequired } : none;
  }
  // Plain-object evidence only: a concrete non-object type (or a node with
  // no object shape at all) carries no required contract.
  const isObjectShaped = s.type === 'object'
    || (s.properties && typeof s.properties === 'object');
  if (!isObjectShaped) return none;
  return { plainRequired: [...new Set(base)], branchRequired: null };
}

// String value-domain view of a schema node, for the union-branch enum
// tightening comparison in diffPropMaps. Answers ONE question with explicit
// evidence: does this node accept ANY free-form string?
//   - acceptsAny: true  -- at least one branch (or the plain node itself) is
//     an unconstrained string (no enum, no non-vacuous pattern), so every
//     string value a caller sends is accepted somewhere.
//   - acceptsAny: false -- every branch is a string constrained by an enum
//     or a non-vacuous pattern: the free-form value domain is gone.
//   - acceptsAny: null  -- unknown (fail-closed, diff layer stays silent):
//     any non-string branch, nested union, allOf wrapping, or unresolvable
//     node poisons the whole view. Length bounds are deliberately NOT
//     treated as domain constraints here (bound churn has its own
//     adjudicated lanes); vacuous patterns (^.*$ family) reject nothing and
//     count as unconstrained.
function stringDomainView(spec, schema) {
  const none = { acceptsAny: null, isUnion: false, constraints: null };
  const s = deref(spec, schema, new Set());
  if (!s || typeof s !== 'object') return none;
  if (Array.isArray(s.allOf)) return none; // conjunctive wrapping: unknown
  const branchView = (node) => {
    const b = deref(spec, node, new Set());
    if (!b || typeof b !== 'object') return null;
    if (Array.isArray(b.oneOf) || Array.isArray(b.anyOf) || Array.isArray(b.allOf)) return null;
    const { type } = normalizeType(b);
    if (type !== 'string') return null;
    const hasEnum = Array.isArray(b.enum) && b.enum.length > 0;
    const hasPattern = typeof b.pattern === 'string' && !VACUOUS_PATTERNS.has(b.pattern);
    return (hasEnum || hasPattern) ? false : true;
  };
  const branches = Array.isArray(s.oneOf) ? s.oneOf
    : Array.isArray(s.anyOf) ? s.anyOf : null;
  if (branches) {
    if (!branches.length) return none;
    let any = false;
    const constraints = [];
    for (const raw of branches) {
      const v = branchView(raw);
      if (v === null) return none; // unknown branch poisons the view
      if (v === true) { any = true; continue; }
      const b = deref(spec, raw, new Set());
      if (Array.isArray(b.enum) && b.enum.length) constraints.push(`enum [${b.enum.map(String).join(', ')}]`);
      else if (typeof b.pattern === 'string') constraints.push(`pattern ${b.pattern}`);
    }
    return { acceptsAny: any, isUnion: true, constraints };
  }
  const v = branchView(schema);
  if (v === null) return none;
  return { acceptsAny: v, isUnion: false, constraints: null };
}

// Normalize a schema node's JSON type + nullability across OAS 3.0 / 3.1.
// Returns { type: string|null, nullable: bool|null }. Format annotations are
// deliberately ignored (format-only churn is generator noise, not breaking).
// null means "unknown" -- diff layer must skip comparisons on unknowns.
function normalizeType(s) {
  if (!s || typeof s !== 'object') return { type: null, nullable: null };
  let type = null;
  let nullable = null;
  if (Array.isArray(s.type)) { // OAS 3.1 type arrays, e.g. ["string","null"]
    const nonNull = s.type.filter((t) => t !== 'null').map(String).sort();
    type = nonNull.length ? nonNull.join('|') : null;
    nullable = s.type.includes('null');
  } else if (typeof s.type === 'string') {
    type = s.type;
    nullable = s.nullable === true; // OAS 3.0 nullable keyword
  } else if (s.nullable === true) {
    nullable = true; // nullable declared without a type: keep type unknown
  }
  return { type, nullable };
}

// ---------- extraction ----------

// Resolve a parameter schema to the SET of JSON types it accepts.
// Handles oneOf/anyOf unions (union of member type sets) and OAS 3.1 type
// arrays. Returns null (= unknown) when any part cannot be resolved to a
// concrete type: the diff layer must skip comparisons on unknowns rather
// than guess (precision over coverage). Format annotations are ignored.
function paramTypeSet(spec, schema, seen = new Set(), depth = 0) {
  if (depth > 3) return null;
  const s = deref(spec, schema, seen);
  if (!s || typeof s !== 'object') return null;
  const out = new Set();
  let sawBranch = false;
  for (const kw of ['oneOf', 'anyOf']) {
    if (!Array.isArray(s[kw])) continue;
    for (const member of s[kw]) {
      sawBranch = true;
      const sub = paramTypeSet(spec, member, new Set(seen), depth + 1);
      if (!sub) return null; // any unknown branch poisons the whole set
      for (const t of sub) out.add(t);
    }
  }
  if (Array.isArray(s.type)) { // OAS 3.1 type arrays
    for (const t of s.type) out.add(String(t));
  } else if (typeof s.type === 'string') {
    out.add(s.type);
  } else if (!sawBranch) {
    return null; // untyped schema: unknown, stay silent
  }
  return out.size ? out : null;
}

// Explicit string-constraint evidence on a parameter schema. Only a plain
// (non-union) schema counts: constraints seen through oneOf/anyOf branches
// are unreliable (a value may satisfy a sibling branch) and resolve to null
// (= unknown, diff layer must skip). Absent keywords also resolve to null --
// oasdiff infers "minLength 0" for an absent lower bound, but absence is not
// evidence of a prior contract, and firing on absent->N fabricates breaking
// changes out of documentation back-fill (PayPal payments_v2 headers grew
// minLength 1 + maxLength 10000 annotations on parameters that were always
// non-empty in practice). Loop 380 adjudication.
function paramConstraints(spec, schema) {
  const none = { minLength: null, maxLength: null, pattern: null };
  const s = deref(spec, schema, new Set());
  if (!s || typeof s !== 'object') return none;
  if (Array.isArray(s.oneOf) || Array.isArray(s.anyOf)) return none;
  return {
    minLength: typeof s.minLength === 'number' ? s.minLength : null,
    maxLength: typeof s.maxLength === 'number' ? s.maxLength : null,
    pattern: typeof s.pattern === 'string' ? s.pattern : null,
  };
}

// Patterns that accept every practical string value reject nothing: adding
// one is annotation churn, not a contract change. Firing on these (PayPal
// stamps `^.*$` / `^[\S\s]*$` on ids and headers wholesale) would violate
// the false-positive-rate-first rule.
const VACUOUS_PATTERNS = new Set(['^.*$', '.*', '^[\\S\\s]*$', '^[\\s\\S]*$', '^(.*)$']);

// Enum surfaces reachable inside a parameter schema, keyed by subpath.
// Query filter parameters commonly carry their contract in array item enums
// (`?resource_types[]=` value lists, `?filters=[{key,operator,value}]`
// envelopes) rather than on the parameter schema itself. oasdiff's
// request-parameter-property-enum-value-removed is the reference case
// (cloudflare ai-gateway logs `filters` items/key lost prompts.prompt_id,
// resource-sharing `resource_types` items enum lost `widget`). Only plain
// (non-union) evidence counts: enums seen through oneOf/anyOf branches are
// approximations (a value may satisfy a sibling branch) and stay silent.
// Subpaths: '' = the parameter schema itself, 'items/' = array item enum,
// 'items/<prop>' = a property of an object array item.
// A parameter schema is "plain" when it resolves to a non-union object:
// union (oneOf/anyOf) evidence is approximate (a value may satisfy a sibling
// branch) and every enum-shaped adjudication must stay silent on it.
function isPlainSchema(spec, schema) {
  const s = deref(spec, schema, new Set());
  if (!s || typeof s !== 'object') return false;
  return !Array.isArray(s.oneOf) && !Array.isArray(s.anyOf);
}

function paramEnumSurfaces(spec, schema) {
  const out = new Map();
  const s = deref(spec, schema, new Set());
  if (!s || typeof s !== 'object') return out;
  if (Array.isArray(s.oneOf) || Array.isArray(s.anyOf)) return out;
  if (Array.isArray(s.enum)) out.set('', s.enum.map(String));
  const items = s.items ? deref(spec, s.items, new Set()) : null;
  if (items && typeof items === 'object' && !Array.isArray(items.oneOf) && !Array.isArray(items.anyOf)) {
    if (Array.isArray(items.enum)) out.set('items/', items.enum.map(String));
    if (items.properties && typeof items.properties === 'object') {
      for (const [name, raw] of Object.entries(items.properties)) {
        const p = deref(spec, raw, new Set());
        if (p && typeof p === 'object' && !Array.isArray(p.oneOf) && !Array.isArray(p.anyOf) && Array.isArray(p.enum)) {
          out.set(`items/${name}`, p.enum.map(String));
        }
      }
    }
  }
  return out;
}

function extractOperations(spec) {
  // Map<`${method} ${path}`, { params: Map, requestProps: Map, responseProps: Map<status, Map> }>
  const ops = new Map();
  const paths = spec.paths || {};
  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue;
    const pathLevelParams = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op || typeof op !== 'object') continue;
      const key = `${method.toUpperCase()} ${path}`;

      const params = new Map();
      const allParams = [...pathLevelParams, ...(Array.isArray(op.parameters) ? op.parameters : [])];
      for (const raw of allParams) {
        const p = deref(spec, raw, new Set());
        if (!p || !p.name) continue;
        params.set(`${p.in || 'query'}:${p.name}`, {
          required: !!p.required,
          types: paramTypeSet(spec, p.schema),
          enums: paramEnumSurfaces(spec, p.schema),
          plain: isPlainSchema(spec, p.schema),
          ...paramConstraints(spec, p.schema),
        });
      }

      let requestProps = new Map();
      let requestPropsDeep = new Map();
      // requestBody may itself be a $ref (`#/components/requestBodies/*` --
      // cloudflare uses ~50 of those), so deref BEFORE reading .content.
      // Reading op.requestBody.content directly left every $ref-shaped body
      // with an empty request surface: cloudflare POST /workers/scripts/
      // {script_name}/versions and PUT dispatch namespace script were fully
      // invisible to the request-side diff. Loop 508. (Response side already
      // derefs; this closes the request-side counterpart.)
      const rbody = deref(spec, op.requestBody, new Set());
      const reqSchema = rbody?.content
        ? Object.values(rbody.content)[0]?.schema
        : null;

      // Per-media request surfaces. The primary pass below reads only the
      // FIRST media type's schema, which leaves every other media type's
      // request surface invisible whenever a body declares several -- e.g.
      // cloudflare PUT dispatch namespace script lists application/javascript
      // (a string scalar) FIRST and multipart/form-data second, so the
      // multipart tightening (outbound.params[] string -> object) never
      // reached the diff. Loop 510. Senders pick a Content-Type and are bound
      // by THAT media's schema, so the extra pass in diffSpecs compares each
      // media type present on BOTH sides by name (media added/removed is
      // lifecycle churn already covered by request-media-type-removed).
      // The first-media maps above are kept as-is: primary-pass behaviour
      // stays bit-for-bit unchanged.
      const requestPropsByMedia = new Map();
      if (rbody && rbody.content && typeof rbody.content === 'object') {
        for (const [mt, mo] of Object.entries(rbody.content)) {
          const schema = mo && typeof mo === 'object' ? mo.schema : null;
          if (!schema) continue;
          requestPropsByMedia.set(mt, {
            props: flattenProps(spec, schema),
            deep: flattenProps(spec, schema, '', 0, new Set(), new Map(), DEEP_PROP_DEPTH),
            // Required-contract view of the body ROOT itself. The
            // union-required tightening comparison in diffPropMaps runs on
            // PROP entries only, so when the body root is the union (e.g.
            // cloudflare d1 /query: oneOf[single query, multiple queries]
            // at the top level) the whole family is invisible there -- the
            // root has no prop entry. Same root-blindness family as the
            // scalar response root (Loop 497). Loop 519.
            rootReqView: objectRequiredView(spec, schema),
          });
        }
      }
      if (reqSchema) {
        requestProps = flattenProps(spec, reqSchema);
        // Deep request map for the tightening pass (see
        // diffDeepRequestTightenings). Request side only: sender-breaking
        // tightenings hide at depth 4+ in generator-restructured specs
        // (PayPal billing subscriber card.number new-required, vault venmo
        // shipping.name prop removals, partner-referrals documents.type enum
        // value removals -- Loop 383/385 adjudicated real gaps beyond
        // MAX_PROP_DEPTH). Response side stays at the shallow cap: deep
        // response churn is reader-tolerant annotation noise and scanning it
        // would violate the false-positive-rate-first rule.
        requestPropsDeep = flattenProps(spec, reqSchema, '', 0, new Set(), new Map(), DEEP_PROP_DEPTH);
      }

      const responseProps = new Map();
      const responseStatuses = new Set();
      // Root type of each response body (normalized, format-free). A scalar
      // root (e.g. `type: number`) flattens to an EMPTY prop map, so a root
      // body being replaced wholesale (number -> object) is invisible to the
      // prop-level diff -- but every reader of the old scalar breaks.
      // Evidence rules: known concrete type on the root schema only; union
      // roots, untyped roots and annotation back-fill (absent -> typed) all
      // normalize to null = no evidence, nothing fires. oasdiff's
      // response-body-type-changed is the reference case (cloudflare POST
      // /accounts/{account_id}/cloudforce-one/events/dataset/{dataset_id}/
      // move 200 body number -> object). Loop 497.
      const responseRootTypes = new Map();
      for (const [status, resp] of Object.entries(op.responses || {})) {
        responseStatuses.add(status);
        const r = deref(spec, resp, new Set());
        const schema = r?.content ? Object.values(r.content)[0]?.schema : null;
        if (schema) {
          responseProps.set(status, flattenProps(spec, schema));
          const root = deref(spec, schema, new Set());
          responseRootTypes.set(status, normalizeType(root).type);
        }
      }

      // Discriminated request unions (oneOf + discriminator.mapping): the
      // discriminator pins each caller to exactly ONE branch, so per-branch
      // schemas are exact evidence -- unlike plain oneOf/anyOf unions, where
      // a value rejected by one branch may satisfy a sibling and the merge
      // must stay conservative. Branches are identity-matched by mapping key
      // (not position), and each branch's props are flattened independently
      // so the diff layer can catch tightenings hidden by the union merge
      // (e.g. an enum value removed from one branch while a sibling keeps
      // it: merged enum still contains the value = silent, but senders of
      // that branch are broken). Fail-closed: no discriminator, no mapping,
      // or unresolvable branch $ref = no branch evidence (null). oasdiff's
      // request-property-enum-value-removed inside a discriminated branch is
      // the reference case (cloudflare POST /accounts/{account_id}/
      // abuse-reports/{report_param} GeneralReport owner_notification enum
      // value `none` removed while CSAM/NCSEI branches keep it). Loop 494.
      const reqRoot = reqSchema ? deref(spec, reqSchema, new Set()) : null;
      let requestBranches = null;
      if (reqRoot && Array.isArray(reqRoot.oneOf) && reqRoot.discriminator
          && typeof reqRoot.discriminator.propertyName === 'string'
          && reqRoot.discriminator.mapping && typeof reqRoot.discriminator.mapping === 'object') {
        const branches = new Map();
        for (const [bkey, ref] of Object.entries(reqRoot.discriminator.mapping)) {
          if (typeof ref !== 'string') continue;
          const target = resolveRef(spec, ref, new Set());
          if (!target) continue;
          branches.set(bkey, flattenProps(spec, target, '', 0, new Set(), new Map()));
        }
        if (branches.size > 0) {
          requestBranches = { disc: reqRoot.discriminator.propertyName, branches };
        }
      }

      // Request body media types (content map keys), read from the same
      // deref'd body as the request surface above. Used by the
      // media-type-removed pass only; empty set = no evidence
      // (fail-closed, nothing fires).
      const bodyMediaTypes = new Set(
        rbody && rbody.content && typeof rbody.content === 'object'
          ? Object.keys(rbody.content) : [],
      );

      ops.set(key, {
        params, requestProps, requestPropsDeep, responseProps, responseStatuses,
        responseRootTypes,
        hasBody: !!op.requestBody,
        // Explicit requestBody.required flag (spec default is false). Kept
        // separately from hasBody so the optional -> required flip can be
        // detected on declared-to-declared evidence only.
        bodyRequired: !!(op.requestBody && op.requestBody.required === true),
        bodyMediaTypes,
        requestPropsByMedia,
        requestBranches,
      });
    }
  }
  return ops;
}

// ---------- diff ----------

// Parent of "a.b[].c" is "a.b" (array markers stripped); root props have
// no parent. Used to decide whether a new required prop actually breaks
// existing callers.
function parentOf(prop) {
  const i = prop.lastIndexOf('.');
  if (i === -1) return null;
  return prop.slice(0, i).replace(/\[\]$/, '');
}

function diffPropMaps(oldProps, newProps, surface, anchor, records) {
  for (const [prop, meta] of oldProps) {
    if (!newProps.has(prop)) {
      // Array item ROOT entries ('...[]', see the itemRoot marker in
      // flattenProps) exist purely to feed the type comparison. Missing on
      // the new side means the item went untyped/union (annotation churn,
      // zero evidence) or the whole array prop vanished (the parent path
      // already carries that removal) -- either way reporting removal here
      // would be a fabricated or duplicate record. Silent.
      if (meta.itemRoot || prop.endsWith('[]')) continue;
      records.push({
        kind: `${surface}-prop-removed`, breaking: true,
        anchor, detail: prop,
      });
      continue;
    }
    const next = newProps.get(prop);
    // Type change: only when both sides have a known, concrete type.
    // Format-only churn never reaches here (normalizeType drops formats).
    if (meta.type && next.type && meta.type !== next.type) {
      records.push({
        kind: `${surface}-prop-type-changed`, breaking: true,
        anchor, detail: `${prop}: ${meta.type} -> ${next.type}`,
      });
    }
    // Nullability: direction of danger depends on the surface.
    // response became nullable = readers may choke on null (breaking).
    // request became NOT nullable = senders of null now rejected (breaking).
    // Only compare when both sides are known (null = unknown, skip).
    if (meta.nullable !== null && next.nullable !== null && meta.nullable !== next.nullable) {
      if (surface === 'response' && next.nullable) {
        records.push({ kind: 'response-prop-became-nullable', breaking: true, anchor, detail: prop });
      } else if (surface === 'request' && meta.nullable && !next.nullable) {
        records.push({ kind: 'request-prop-became-not-nullable', breaking: true, anchor, detail: prop });
      }
      // Widening directions (request became nullable / response became
      // non-nullable) are non-breaking for consumers: skipped, low signal.
    }
    // Union-required tightening on an object-shaped request prop: the OLD
    // node accepted the EMPTY object (plain object with no required list, or
    // a union with at least one requirement-free branch), the NEW node is a
    // union whose EVERY branch requires at least one property -- so callers
    // who legitimately sent `{}` (or omitted every field) are now rejected
    // no matter which branch validation tries. The union merge in
    // flattenProps intentionally marks per-branch required as non-required
    // (a prop required in one branch only is conditional), so this whole
    // family is invisible to the became-required/added-required passes --
    // this comparison reads the node-level required contract instead.
    // Evidence rules, all fail-closed (objectRequiredView): request side
    // only; both sides must resolve to a known contract (ambiguous shapes --
    // nested unions, double unions inside allOf -- resolve to unknown and
    // stay silent); NEW must be a union (plain-to-plain required growth is
    // the existing added/became-required passes' territory, mutually
    // exclusive by construction); allOf siblings merge conjunctively into
    // every branch. The reverse direction (union -> accepts empty) widens
    // and stays silent. oasdiff's request-property-all-of-added is the
    // reference case (cloudflare PUT dispatch namespace script
    // metadata.placement: plain optional-everything object -> oneOf where
    // all 8 branches require mode/region/hostname/host -- Loop 513 adjudged
    // real tightening, Loop 517). Detail carries the per-branch keys so the
    // record is reviewable without re-walking the spec.
    if (surface === 'request' && meta.reqView && next.reqView) {
      const acceptsEmpty = (v) => (v.plainRequired ? v.plainRequired.length === 0
        : v.branchRequired ? v.branchRequired.some((b) => b.length === 0) : null);
      const oldEmpty = acceptsEmpty(meta.reqView);
      const newEmpty = acceptsEmpty(next.reqView);
      if (oldEmpty === true && newEmpty === false && next.reqView.branchRequired) {
        records.push({
          kind: 'request-prop-union-required-tightened', breaking: true,
          anchor,
          detail: `${prop}: every union branch now requires [${[...new Set(next.reqView.branchRequired.flat())].sort().join(', ')}]`,
        });
      }
    }
    // Pattern constraint ADDED on a request prop: values that used to pass
    // now get rejected by validation -> breaking for senders. Only fired when
    // the old side verifiably had NO pattern and neither side's evidence came
    // through a union merge (union-derived patterns are approximations).
    // Pattern REWRITES (old pattern -> new pattern) and response-side pattern
    // churn are deliberately silent: comparing regex languages for narrowing
    // is undecidable in general, and generators shuffle response annotations
    // constantly -- reporting those would violate the false-positive-first
    // rule. oasdiff's request-property-pattern-added is the reference case
    // (vercel v1.28.1->v1.28.2 POST /v1/connect/connectors icon).
    if (surface === 'request' && meta.pattern === null && typeof next.pattern === 'string'
        && !meta.viaUnion && !next.viaUnion) {
      records.push({
        kind: 'request-prop-pattern-added', breaking: true,
        anchor, detail: `${prop} pattern ${next.pattern}`,
      });
    }
    // Enum INTRODUCED on a request prop that verifiably had none: a finite
    // value set now rejects every previously-valid value outside it ->
    // breaking for senders. Unlike numeric-bound back-fill (absent minLength
    // -> explicit, adjudicated annotation churn in the param work), an enum
    // is never a vacuous constraint -- it always excludes values. Fired only
    // when the old side has a KNOWN type and no enum, and neither side's
    // evidence came through a union merge (union-derived enums are
    // approximations). Response-side enum introduction narrows what readers
    // can receive = non-breaking for consumers, deliberately silent. oasdiff
    // request-property-became-enum is the reference case (PayPal vault
    // wallet_base usage_type: no enum -> [MERCHANT, PLATFORM]). Loop 384.
    if (surface === 'request' && meta.enum === null && meta.type && next.enum
        && !meta.viaUnion && !next.viaUnion) {
      records.push({
        kind: 'request-prop-became-enum', breaking: true,
        anchor, detail: `${prop} enum [${next.enum.join(', ')}]`,
      });
    }
    // Union-branch string-domain tightening: a request prop whose OLD shape
    // accepted ANY free-form string (a plain unconstrained string, or a
    // union with at least one unconstrained string branch) became a union
    // where EVERY branch is constrained (enum or non-vacuous pattern) -- so
    // callers sending values outside the constrained sets are now rejected
    // no matter which branch validation tries. The plain->enum case is the
    // existing request-prop-became-enum lane (mutually exclusive: this one
    // requires the NEW side to be a union); the union merge in flattenProps
    // drops per-branch enums to unknown by design, making this family
    // invisible to that lane. Evidence rules, all fail-closed
    // (stringDomainView): request side only; both sides must resolve to a
    // known string domain (any non-string branch, nested union, or allOf
    // wrapping resolves to unknown and stays silent); vacuous patterns count
    // as unconstrained; the reverse direction (constrained -> accepts any)
    // widens and stays silent. oasdiff's request-property-became-enum on a
    // union node is the reference case (vercel v1.28.10->v1.28.11 POST
    // /v1/connect/token/{connector}/import tokens[].environment: anyOf
    // [free string, ^env_ string] -> anyOf [enum {development, preview,
    // production}, ^env_ string]). Detail carries the per-branch
    // constraints so the record is reviewable without re-walking the spec.
    if (surface === 'request' && meta.strView && next.strView
        && meta.strView.acceptsAny === true && next.strView.acceptsAny === false
        && next.strView.isUnion) {
      records.push({
        kind: 'request-prop-union-enum-tightened', breaking: true,
        anchor,
        detail: `${prop}: every union branch now constrained (${(next.strView.constraints || []).join('; ')})`,
      });
    }
    // Request prop maxLength DECREASED: values that used to pass length
    // validation now get rejected -> breaking for senders. Fired ONLY on
    // explicit-to-explicit evidence (both sides declare a numeric maxLength;
    // absent = unknown = silent, mirroring the param-side rule and the
    // back-fill adjudication -- oasdiff infers bounds for absent keywords,
    // we never do). Union-derived evidence never fires (union merges drop
    // the bound to unknown by construction). Increases and every
    // response-side direction are widening/reader-tolerant churn:
    // deliberately silent. Reference case: PayPal checkout_orders
    // purchase_units description 3000 -> 127, soft_descriptor 1000 -> 22,
    // items[].name 3000 -> 127 (Loop 396 adjudicated real specdiff miss).
    // Loop 397.
    if (surface === 'request'
        && typeof meta.maxLength === 'number' && typeof next.maxLength === 'number'
        && next.maxLength < meta.maxLength
        && !meta.viaUnion && !next.viaUnion) {
      records.push({
        kind: 'request-prop-max-length-decreased', breaking: true,
        anchor, detail: `${prop}: maxLength ${meta.maxLength} -> ${next.maxLength}`,
      });
    }
    // Request prop maxItems DECREASED: arrays that used to pass cardinality
    // validation now get rejected -> breaking for senders. Exact same
    // fail-closed shape as request-prop-max-length-decreased above:
    // explicit-to-explicit numeric evidence only (absent = unknown = silent,
    // never back-filled), union-derived evidence never fires (union merges
    // drop the bound by construction), increases and every response-side
    // direction are widening/reader-tolerant churn: deliberately silent.
    // Reference case: PayPal checkout_orders shipping.options maxItems
    // 30 -> 10 (Loop 398 adjudicated real specdiff miss). Loop 399.
    if (surface === 'request'
        && typeof meta.maxItems === 'number' && typeof next.maxItems === 'number'
        && next.maxItems < meta.maxItems
        && !meta.viaUnion && !next.viaUnion) {
      records.push({
        kind: 'request-prop-max-items-decreased', breaking: true,
        anchor, detail: `${prop}: maxItems ${meta.maxItems} -> ${next.maxItems}`,
      });
    }
    // Request prop minItems INCREASED (or introduced at >= 1): arrays that
    // used to pass cardinality validation now get rejected -> breaking for
    // senders. Two evidence shapes fire, both fail-closed:
    //   (a) explicit-to-explicit increase (both sides declare numeric
    //       minItems, new > old), mirroring the max-side kinds;
    //   (b) INTRODUCTION on a prop whose old type is verifiably `array` and
    //       carried no minItems. Unlike absent minLength (adjudicated as
    //       vacuous "0" annotation back-fill, Loop 389), a minItems >= 1 is
    //       never vacuous -- it always rejects the empty array, which the
    //       old schema accepted. Same reasoning as the enum-introduced kind
    //       (request-prop-became-enum, Loop 384). Introduction at 0 is a
    //       no-op annotation: silent. Union-derived evidence never fires;
    //       decreases and every response-side direction are widening /
    //       reader-tolerant churn: deliberately silent. Reference case:
    //       cloudflare b61f904f->7abe8850 POST /zones/{zone_id}/email/
    //       routing/rules `actions` minItems absent -> 1 (plus catch_all /
    //       {rule_identifier} PUT and POST /certificates `hostnames`),
    //       oasdiff request-property-min-items-increased, Loop 473
    //       adjudicated real gaps. Loop 480.
    if (surface === 'request'
        && typeof next.minItems === 'number' && next.minItems >= 1
        && !meta.viaUnion && !next.viaUnion
        && ((typeof meta.minItems === 'number' && next.minItems > meta.minItems)
          || (meta.minItems === null && meta.type === 'array'))) {
      records.push({
        kind: 'request-prop-min-items-increased', breaking: true,
        anchor, detail: `${prop}: minItems ${typeof meta.minItems === 'number' ? meta.minItems : 'none'} -> ${next.minItems}`,
      });
    }
    if (meta.enum && next.enum) {
      for (const v of meta.enum) {
        if (!next.enum.includes(v)) {
          records.push({ kind: 'enum-value-removed', breaking: true, anchor, detail: `${prop} = ${v}` });
        }
      }
      for (const v of next.enum) {
        if (!meta.enum.includes(v)) {
          records.push({ kind: 'enum-value-added', breaking: false, anchor, detail: `${prop} = ${v}` });
        }
      }
    }
    // Request prop flipped optional -> required: existing callers that omit
    // the field now get rejected -> breaking for senders. Required lists are
    // explicit in OpenAPI, so absent-on-old is real evidence (not back-fill
    // like numeric bounds). Fired only when neither side's required flag came
    // through a oneOf/anyOf union merge (union-derived flags are conservative
    // approximations, see the union merge above). Response-side optional ->
    // required is a STRONGER guarantee for readers = non-breaking, silent.
    // oasdiff's request-property-became-required is the reference case
    // (PayPal billing_subscriptions subscriber card.number/expiry). Loop 393.
    if (surface === 'request' && !meta.required && next.required
        && !meta.viaUnion && !next.viaUnion) {
      records.push({ kind: 'request-prop-became-required', breaking: true, anchor, detail: prop });
    }
    // Response prop required -> optional: the field may now be absent from
    // payloads. Defensive readers (optional chaining, null checks) are
    // unaffected, so this is graded WARNING, not breaking -- flagging it as
    // breaking would fire on every generator required-list shuffle and
    // violate the false-positive-rate-first rule. Skipped when either side's
    // required flag came through a oneOf/anyOf union merge: union-derived
    // required flags are conservative approximations, not evidence.
    if (surface === 'response' && meta.required && !next.required
        && !meta.viaUnion && !next.viaUnion) {
      records.push({ kind: 'response-prop-became-optional', breaking: false, warning: true, anchor, detail: prop });
    }
  }
  for (const [prop, meta] of newProps) {
    if (oldProps.has(prop)) continue;
    // Array item ROOT entries newly visible (old side untyped/union, or the
    // array prop itself is new -- the parent path carries that) are
    // annotation-level evidence only: silent (see itemRoot in flattenProps).
    if (meta.itemRoot || prop.endsWith('[]')) continue;
    // A required prop nested inside a NEWLY-ADDED parent subtree is only
    // required for callers who opt into the new (optional) parent -- existing
    // requests keep working. Reporting it as added-required fabricates
    // breaking changes (Vercel firewall rulesets[].name shape). Breaking-ness
    // is decided at the topmost new node: required only counts when every
    // ancestor already existed in the old shape (or the prop is root-level).
    const parent = parentOf(prop);
    const parentIsNew = parent !== null && !oldProps.has(parent);
    if (surface === 'request' && meta.required && !parentIsNew) {
      records.push({ kind: 'request-prop-added-required', breaking: true, anchor, detail: prop });
    } else {
      records.push({ kind: `${surface}-prop-added`, breaking: false, anchor, detail: prop });
    }
  }
}

// Deep request-side tightening pass (Loop 386). The shallow diffPropMaps pass
// is bounded at MAX_PROP_DEPTH to keep response-side noise out, but three
// adjudicated PayPal real gaps proved sender-breaking tightenings hide below
// that cap in generator-restructured request bodies:
//   - new required prop at depth 4+ (billing subscriber card.number/expiry)
//   - prop removed at depth 4+ (vault venmo shipping.name family)
//   - enum value removed at depth 4+ (partner-referrals documents.type
//     BUSINESS_REGISTRATION)
// This pass diffs the DEEP request maps but only for prop paths INVISIBLE to
// the shallow pass (present in neither side's shallow map): everything the
// shallow pass can see keeps its existing adjudication, so shallow behaviour
// is bit-for-bit unchanged. Fail-closed guards mirror the shallow pass:
// union-derived evidence never fires, removal is reported at the topmost
// removed node only, and required-inside-new-subtree stays additive.
function diffDeepRequestTightenings(oldDeep, newDeep, oldShallow, newShallow, anchor, records) {
  const invisible = (prop) => !oldShallow.has(prop) && !newShallow.has(prop);
  for (const [prop, meta] of oldDeep) {
    if (!invisible(prop)) continue;
    // Array item ROOT entries: type-feed only, never removal evidence
    // (same rule as the shallow pass -- see itemRoot in flattenProps).
    if (!newDeep.has(prop)) {
      if (meta.itemRoot || prop.endsWith('[]')) continue;
      // Report the topmost removed node only: if the parent subtree is gone
      // too, the parent (or the shallow pass) carries the report.
      const parent = parentOf(prop);
      if (parent !== null && oldDeep.has(parent) && !newDeep.has(parent)) continue;
      records.push({ kind: 'request-prop-removed', breaking: true, anchor, detail: prop });
      continue;
    }
    const next = newDeep.get(prop);
    // Type replaced below the shallow cap: same semantics as the shallow
    // request-prop-type-changed (senders now send the wrong type). Both
    // sides must carry a known concrete type. Union-merged evidence is
    // acceptable here for the SAME reason the shallow pass accepts it:
    // the union merge drops type to null whenever branches disagree, so a
    // surviving concrete type means every defining branch agrees -- real
    // evidence, not approximation (unlike required/enum union merges).
    // Reference case: cloudflare b61f904f->7abe8850 workers
    // dispatch_namespace binding outbound.params array items string ->
    // object at depth 4+ (oasdiff request-property-type-changed), Loop 505.
    if (meta.type && next.type && meta.type !== next.type) {
      records.push({
        kind: 'request-prop-type-changed', breaking: true,
        anchor, detail: `${prop}: ${meta.type} -> ${next.type}`,
      });
    }
    // Optional -> required flip below the shallow cap: same semantics as the
    // shallow request-prop-became-required (senders omitting the field now
    // rejected). Same fail-closed guards: union-derived flags never fire, and
    // required lists are explicit evidence. Loop 393.
    if (!meta.required && next.required && !meta.viaUnion && !next.viaUnion) {
      records.push({ kind: 'request-prop-became-required', breaking: true, anchor, detail: prop });
    }
    // Pattern ADDED on a deep request prop: same semantics and fail-closed
    // guards as the shallow request-prop-pattern-added branch (old side
    // verifiably had NO pattern, neither side via union merge; rewrites and
    // response churn deliberately silent -- the deep pass is request-only by
    // construction). Reference case: PayPal checkout_orders
    // purchase_units[].supplementary_data.card.level_3.line_items[].image_url
    // pattern added at depth 5+, beyond the shallow MAX_PROP_DEPTH=3 cap
    // (Loop 398 adjudicated real tightening, Loop 400).
    if (meta.pattern === null && typeof next.pattern === 'string'
        && !meta.viaUnion && !next.viaUnion) {
      records.push({
        kind: 'request-prop-pattern-added', breaking: true,
        anchor, detail: `${prop} pattern ${next.pattern}`,
      });
    }
    // Enum value removed: explicit-to-explicit evidence only, and never
    // through a union merge (union enums are approximations).
    if (meta.enum && next.enum && !meta.viaUnion && !next.viaUnion) {
      for (const v of meta.enum) {
        if (!next.enum.includes(v)) {
          records.push({ kind: 'enum-value-removed', breaking: true, anchor, detail: `${prop} = ${v}` });
        }
      }
    }
  }
  for (const [prop, meta] of newDeep) {
    if (!invisible(prop) || oldDeep.has(prop)) continue;
    // Required prop nested inside a newly-added parent subtree only binds
    // callers who opt into the new parent: stays silent here (the shallow
    // pass already reports the topmost new node as additive when visible).
    const parent = parentOf(prop);
    const parentIsNew = parent !== null && !oldDeep.has(parent);
    if (meta.required && !parentIsNew && !meta.viaUnion) {
      records.push({ kind: 'request-prop-added-required', breaking: true, anchor, detail: prop });
    }
  }
}

export function diffSpecs(oldSpec, newSpec) {
  const records = [];
  const oldOps = extractOperations(oldSpec);
  const newOps = extractOperations(newSpec);

  const oldPaths = new Set([...oldOps.keys()].map((k) => k.split(' ')[1]));
  const newPaths = new Set([...newOps.keys()].map((k) => k.split(' ')[1]));

  for (const path of oldPaths) {
    if (!newPaths.has(path)) records.push({ kind: 'path-removed', breaking: true, anchor: path, detail: '' });
  }
  for (const path of newPaths) {
    if (!oldPaths.has(path)) records.push({ kind: 'path-added', breaking: false, anchor: path, detail: '' });
  }

  for (const [key, oldOp] of oldOps) {
    const path = key.split(' ')[1];
    if (!newOps.has(key)) {
      if (newPaths.has(path)) records.push({ kind: 'operation-removed', breaking: true, anchor: key, detail: '' });
      continue; // path-removed already recorded
    }
    const newOp = newOps.get(key);

    for (const [pkey, meta] of oldOp.params) {
      if (!newOp.params.has(pkey)) {
        records.push({ kind: 'param-removed', breaking: true, anchor: key, detail: pkey });
      } else {
        const next = newOp.params.get(pkey);
        if (!meta.required && next.required) {
          records.push({ kind: 'param-now-required', breaking: true, anchor: key, detail: pkey });
        }
        // Parameter type-set narrowing: a type accepted before is gone now
        // (e.g. oneOf[string,boolean] -> string). Senders of the dropped type
        // get rejected -> breaking. Only fired when BOTH sides resolved to
        // concrete type sets (null = unknown, skip) and the removal is real
        // (widening / identical sets stay silent). oasdiff's
        // request-parameter-list-of-types-narrowed is the reference case
        // (vercel v1.28.5->v1.28.6 GET /v9/projects/{idOrName} idOrName).
        if (meta.types && next.types) {
          const dropped = [...meta.types].filter((t) => !next.types.has(t));
          if (dropped.length && dropped.length < meta.types.size) {
            records.push({
              kind: 'param-type-narrowed', breaking: true, anchor: key,
              detail: `${pkey}: -${dropped.sort().join(',-')}`,
            });
          } else if (dropped.length && dropped.length === meta.types.size) {
            // Parameter type REPLACED wholesale: the old and new type sets
            // are disjoint (every previously accepted type is gone), so every
            // value existing callers send gets rejected -> breaking. This is
            // distinct from narrowing (partial removal, handled above) and
            // deliberately excluded by its `dropped < size` guard; without
            // this branch a full replacement is invisible. Overlapping sets
            // stay in the narrowing/widening lanes; unknown sides (null)
            // never reach here. oasdiff's request-parameter-type-changed is
            // the reference case (cloudflare cloudforce-one events/indicators
            // `search` query param: string -> array<object>). Loop 492.
            records.push({
              kind: 'param-type-changed', breaking: true, anchor: key,
              detail: `${pkey}: ${[...meta.types].sort().join('|')} -> ${[...next.types].sort().join('|')}`,
            });
          }
        }
        // String-constraint TIGHTENING on a request parameter: values senders
        // used to pass now get rejected by validation -> breaking. Fired only
        // on explicit-to-explicit evidence (both sides carry the keyword;
        // absent = unknown = silent, see paramConstraints). Loosening
        // directions (min decreased / max increased / pattern removed) widen
        // the accepted value set and stay silent. oasdiff's
        // request-parameter-max-length-decreased is the reference case
        // (paypal checkout_orders paypal-client-metadata-id GUID 68 -> 36).
        if (meta.minLength !== null && next.minLength !== null && next.minLength > meta.minLength) {
          records.push({
            kind: 'param-min-length-increased', breaking: true, anchor: key,
            detail: `${pkey}: minLength ${meta.minLength} -> ${next.minLength}`,
          });
        }
        if (meta.maxLength !== null && next.maxLength !== null && next.maxLength < meta.maxLength) {
          records.push({
            kind: 'param-max-length-decreased', breaking: true, anchor: key,
            detail: `${pkey}: maxLength ${meta.maxLength} -> ${next.maxLength}`,
          });
        }
        // Enum value REMOVED from a parameter enum surface (the schema
        // itself, its array items, or an item property): senders of the
        // dropped value get rejected -> breaking. Fired only on
        // declared-to-declared evidence (both sides carry an enum at the
        // same subpath); enum removed wholesale = widening = silent, enum
        // introduced = handled nowhere (absence is not prior contract).
        // Value ADDED to a parameter enum widens the accepted set = silent.
        // oasdiff's request-parameter-property-enum-value-removed is the
        // reference case (cloudflare filters items/key, resource_types
        // items). Loop 479.
        for (const [sub, oldVals] of meta.enums) {
          const newVals = next.enums.get(sub);
          if (!newVals) continue;
          for (const v of oldVals) {
            if (!newVals.includes(v)) {
              records.push({
                kind: 'param-enum-value-removed', breaking: true, anchor: key,
                detail: `${pkey} ${sub ? sub + ' ' : ''}= ${v}`,
              });
            }
          }
        }
        // Parameter BECAME an enum where the old side verifiably had a typed,
        // enum-free, non-union schema: a finite value set now rejects every
        // previously-valid value outside it -> breaking for senders. This is
        // the parameter-side mirror of request-prop-became-enum (Loop 384):
        // an enum is never a vacuous constraint, unlike numeric-bound
        // back-fill. Fired only when BOTH sides are plain (non-union) schemas
        // with a known old type set -- union-derived evidence is approximate
        // and stays silent (a value may satisfy a sibling branch), and an
        // untyped old schema gives no proof the freeform contract existed.
        // Enum removed wholesale = widening = silent. oasdiff's
        // request-parameter-became-enum is the reference case (cloudflare
        // stream download_type: string -> enum [default, audio]). Loop 483.
        if (!meta.enums.has('') && next.enums.has('')
            && meta.plain && next.plain && meta.types) {
          records.push({
            kind: 'param-became-enum', breaking: true, anchor: key,
            detail: `${pkey} enum [${next.enums.get('').join(', ')}]`,
          });
        }
        // Pattern ADDED where the old side verifiably had none. Vacuous
        // match-anything patterns reject nothing and stay silent (PayPal
        // stamps `^[\S\s]*$` on ids wholesale = annotation churn). Pattern
        // REWRITES stay silent: comparing regex languages for narrowing is
        // undecidable (same adjudication as request-prop-pattern-added).
        if (meta.pattern === null && meta.types && meta.types.has('string')
            && typeof next.pattern === 'string' && !VACUOUS_PATTERNS.has(next.pattern)) {
          records.push({
            kind: 'param-pattern-added', breaking: true, anchor: key,
            detail: `${pkey} pattern ${next.pattern}`,
          });
        }
      }
    }
    for (const [pkey, meta] of newOp.params) {
      if (oldOp.params.has(pkey)) continue;
      records.push({
        kind: meta.required ? 'param-added-required' : 'param-added-optional',
        breaking: !!meta.required, anchor: key, detail: pkey,
      });
    }

    // Request body removed wholesale: every caller that sends a body now
    // targets an operation that no longer declares one -- servers commonly
    // reject or silently ignore the payload, and generated SDKs drop the
    // body argument from the signature. Breaking for senders. Fired only on
    // declared-to-absent evidence (op.requestBody present in OLD, absent in
    // NEW); the reverse direction (body added) is additive when optional and
    // already surfaces through the prop pass when required. oasdiff's
    // request-body-removed is the reference case (paypal invoicing_v2
    // POST /v2/invoicing/generate-next-invoice-number 7bbed782->fb6f126).
    if (oldOp.hasBody && !newOp.hasBody) {
      records.push({ kind: 'request-body-removed', breaking: true, anchor: key, detail: '' });
    }

    // Request body optional -> required flip: callers that legitimately sent
    // no body (requestBody.required defaults to false) now get rejected =
    // breaking for senders. Fired only on declared-to-declared evidence
    // (body present on BOTH sides, explicit required:true only on NEW; body
    // appearing at the same time is additive-shape churn already covered by
    // the prop pass). The reverse direction (required -> optional) widens
    // the contract and stays silent. oasdiff's request-body-became-required
    // is the reference case (cloudflare browser-rendering endpoints
    // b61f904f10c9 -> 7abe88500e55, Loop 473 real-gap adjudication).
    if (oldOp.hasBody && newOp.hasBody && !oldOp.bodyRequired && newOp.bodyRequired) {
      records.push({ kind: 'request-body-became-required', breaking: true, anchor: key, detail: '' });
    }

    // Request body ADDED as required on an operation that previously declared
    // no body at all: every existing caller legitimately sent no payload and
    // now gets rejected = breaking for senders. Fired only on explicit
    // evidence (no requestBody in OLD, requestBody with required:true in
    // NEW). An OPTIONAL body appearing is purely additive and stays silent;
    // body present on both sides is the became-required flip's territory
    // (mutually exclusive guards, one change never fires two kinds).
    // oasdiff's request-body-added-required is the reference case (cloudflare
    // PATCH /accounts/{account_id}/brand-protection/queries
    // b61f904f10c9 -> 7abe88500e55, Loop 490 real-gap adjudication).
    if (!oldOp.hasBody && newOp.hasBody && newOp.bodyRequired) {
      records.push({ kind: 'request-body-added-required', breaking: true, anchor: key, detail: '' });
    }

    // Request body media type removed: callers sending that Content-Type get
    // rejected (415 or parse failure) = breaking for senders. Fired only on
    // declared-to-declared evidence (both sides have at least one media type,
    // the removed one was explicitly declared in OLD and is absent in NEW).
    // Media type ADDED is additive and stays silent; body removed wholesale
    // is already covered by request-body-removed (empty NEW set is excluded
    // here so one change never fires two kinds). oasdiff's
    // request-body-media-type-removed is the reference case (cloudflare
    // POST /accounts/{account_id}/ai/tomarkdown b61f904f10c9 -> 7abe88500e55,
    // application/octet-stream replaced by multipart/form-data).
    if (oldOp.bodyMediaTypes.size > 0 && newOp.bodyMediaTypes.size > 0) {
      for (const mt of oldOp.bodyMediaTypes) {
        if (!newOp.bodyMediaTypes.has(mt)) {
          records.push({ kind: 'request-media-type-removed', breaking: true, anchor: key, detail: mt });
        }
      }
    }

    diffPropMaps(oldOp.requestProps, newOp.requestProps, 'request', key, records);
    diffDeepRequestTightenings(oldOp.requestPropsDeep, newOp.requestPropsDeep,
      oldOp.requestProps, newOp.requestProps, key, records);

    // Secondary per-media request pass (Loop 510). The primary pass above
    // reads only the FIRST media type's schema on each side, so when a body
    // declares several media types every other media's request surface is
    // invisible -- cloudflare PUT dispatch namespace script lists
    // application/javascript (string scalar) first and multipart/form-data
    // second, hiding the multipart outbound.params[] string -> object
    // tightening. Here every media type present on BOTH sides by name gets
    // the same shallow + deep diff. Fail-closed rules:
    //   - identity is the media type name on both sides (media added or
    //     removed is lifecycle churn: request-media-type-removed covers it);
    //   - records identical (kind + detail) to one already filed at this
    //     anchor are dropped, so a schema shared across media types (the
    //     common generator layout) never double-fires -- primary-pass
    //     output is bit-for-bit unchanged when all media share one schema;
    //   - genuinely media-specific findings carry no media marker in detail
    //     on purpose: the anchor contract (endpoint + prop path) stays
    //     stable for pack matching and the parity harness.
    if (oldOp.requestPropsByMedia.size > 0 && newOp.requestPropsByMedia.size > 0) {
      const seen = new Set(records.map((r) => `${r.kind}\u0000${r.anchor}\u0000${r.detail}`));
      for (const [mt, oldSurf] of oldOp.requestPropsByMedia) {
        const newSurf = newOp.requestPropsByMedia.get(mt);
        if (!newSurf) continue;
        const extra = [];
        // Union-required tightening on the body ROOT itself (Loop 519).
        // The prop-level comparison inside diffPropMaps never sees the root
        // node (it has no prop entry), so a top-level oneOf whose every
        // branch now requires a property is invisible there -- cloudflare
        // POST d1 /query and /raw are the reference case (oneOf[single
        // query, multiple queries]: the requirement-free `multiple queries`
        // branch gained required [batch], so `{}` senders who used to pass
        // that branch are rejected by every branch). Same fail-closed rules
        // as the prop-level pass: both sides must resolve to a known
        // contract, OLD must accept the empty payload, NEW must be a union
        // with every branch requiring something. Detail uses the stable
        // `body root` token (there is no prop path at the root).
        if (oldSurf.rootReqView && newSurf.rootReqView) {
          const acceptsEmpty = (v) => (v.plainRequired ? v.plainRequired.length === 0
            : v.branchRequired ? v.branchRequired.some((b) => b.length === 0) : null);
          if (acceptsEmpty(oldSurf.rootReqView) === true
              && acceptsEmpty(newSurf.rootReqView) === false
              && newSurf.rootReqView.branchRequired) {
            extra.push({
              kind: 'request-prop-union-required-tightened', breaking: true,
              anchor: key,
              detail: `body root: every union branch now requires [${[...new Set(newSurf.rootReqView.branchRequired.flat())].sort().join(', ')}]`,
            });
          }
        }
        diffPropMaps(oldSurf.props, newSurf.props, 'request', key, extra);
        diffDeepRequestTightenings(oldSurf.deep, newSurf.deep,
          oldSurf.props, newSurf.props, key, extra);
        for (const r of extra) {
          const sig = `${r.kind}\u0000${r.anchor}\u0000${r.detail}`;
          if (seen.has(sig)) continue;
          seen.add(sig);
          records.push(r);
        }
      }
    }

    // Discriminated request branch tightenings: enum value removed INSIDE a
    // discriminator-mapped branch. The union-merged shallow pass takes the
    // UNION of enum values across branches (correct for plain unions), so a
    // value removed from one branch while a sibling keeps it never surfaces
    // there -- but with a discriminator the caller is pinned to the branch
    // its discriminator value selects, and senders of the removed value ARE
    // broken. Evidence rules, all fail-closed:
    //   - branches identity-matched by discriminator mapping KEY on both
    //     sides (branch added/removed = lifecycle churn, not enum evidence);
    //   - explicit-to-explicit enum on the same prop path inside the branch,
    //     never via a nested union merge;
    //   - the discriminator property itself is skipped (its per-branch enum
    //     is the mapping key, already covered by branch lifecycle);
    //   - skipped when the union-merged pass already reported the same
    //     prop+value at this anchor (value gone from every branch): one
    //     change never fires twice.
    if (oldOp.requestBranches && newOp.requestBranches
        && oldOp.requestBranches.disc === newOp.requestBranches.disc) {
      const disc = oldOp.requestBranches.disc;
      for (const [bkey, oldProps] of oldOp.requestBranches.branches) {
        const newProps = newOp.requestBranches.branches.get(bkey);
        if (!newProps) continue; // branch removed: lifecycle, not enum evidence
        for (const [prop, meta] of oldProps) {
          if (prop === disc) continue;
          const next = newProps.get(prop);
          if (!next) {
            // Prop removed INSIDE a branch while a sibling branch keeps it:
            // the union merge still contains the prop, so the shallow pass is
            // silent -- but senders pinned to this branch break. Report the
            // topmost removed node only (parent gone = parent carries it),
            // never on union-derived evidence, and dedup against the
            // union-merged pass (prop gone from EVERY branch = merged map
            // loses it and the shallow pass already fired, unsuffixed).
            if (meta.viaUnion) continue;
            const parent = parentOf(prop);
            if (parent !== null && oldProps.has(parent) && !newProps.has(parent)) continue;
            const dup = records.some((r) => r.kind === 'request-prop-removed'
              && r.anchor === key && r.detail === prop);
            if (dup) continue;
            records.push({
              kind: 'request-prop-removed', breaking: true, anchor: key,
              detail: `${prop} (branch ${bkey})`,
            });
            continue;
          }
          // Optional -> required flip INSIDE a branch: the union merge marks
          // a prop required only when required in EVERY branch (and flags it
          // viaUnion, which the shallow flip guard skips), so a per-branch
          // flip is invisible there -- but callers pinned to this branch who
          // omit the field are now rejected. Explicit-to-explicit required
          // evidence only, never via a nested union merge; dedup mirrors the
          // enum pass (one change never fires twice).
          if (!meta.required && next.required && !meta.viaUnion && !next.viaUnion) {
            const dup = records.some((r) => r.kind === 'request-prop-became-required'
              && r.anchor === key && r.detail === prop);
            if (!dup) {
              records.push({
                kind: 'request-prop-became-required', breaking: true, anchor: key,
                detail: `${prop} (branch ${bkey})`,
              });
            }
          }
          if (!meta.enum || !next.enum || meta.viaUnion || next.viaUnion) continue;
          for (const v of meta.enum) {
            if (next.enum.includes(v)) continue;
            const dup = records.some((r) => r.kind === 'enum-value-removed'
              && r.anchor === key && r.detail === `${prop} = ${v}`);
            if (dup) continue;
            records.push({
              kind: 'enum-value-removed', breaking: true, anchor: key,
              detail: `${prop} = ${v} (branch ${bkey})`,
            });
          }
        }
      }
    }

    // A SUCCESS status code disappearing is breaking: callers branching on
    // that code (e.g. 202 Accepted) stop matching. Checked on the raw status
    // set (independent of whether the response carries a schema -- 202s are
    // often bodyless). Error-code churn (4xx/5xx definitions come and go in
    // generated specs) stays silent: reporting it would fire on documentation
    // cleanup, violating the false-positive-rate-first rule.
    for (const status of oldOp.responseStatuses) {
      if (!newOp.responseStatuses.has(status) && /^2\d\d$/.test(status)) {
        records.push({ kind: 'response-status-removed', breaking: true, anchor: `${key} -> ${status}`, detail: '' });
      }
    }

    const statuses = new Set([...oldOp.responseProps.keys(), ...newOp.responseProps.keys()]);
    for (const status of statuses) {
      const o = oldOp.responseProps.get(status);
      const n = newOp.responseProps.get(status);
      if (!o || !n) continue; // status added, or removed (handled above): skip prop diff
      diffPropMaps(o, n, 'response', `${key} -> ${status}`, records);
      // Response body ROOT type replaced wholesale (scalar <-> object/array):
      // a scalar root has an empty prop map, so the prop-level diff above is
      // structurally blind to it -- yet every reader of the old shape breaks
      // (e.g. `const count = await res.json()` now yields an object).
      // Success statuses only (error-shape churn = generated-spec noise);
      // known-to-known concrete types only, and only when the normalized
      // types differ. Union/untyped roots normalize to null = silent
      // (fail-closed). oasdiff's response-body-type-changed is the reference
      // case (cloudflare cloudforce-one move 200: number -> object). Loop 497.
      if (/^2\d\d$/.test(status)) {
        const ot = oldOp.responseRootTypes?.get(status) ?? null;
        const nt = newOp.responseRootTypes?.get(status) ?? null;
        if (ot && nt && ot !== nt) {
          records.push({
            kind: 'response-body-type-changed', breaking: true,
            anchor: `${key} -> ${status}`, detail: `${ot} -> ${nt}`,
          });
        }
      }
    }
  }
  for (const [key] of newOps) {
    const path = key.split(' ')[1];
    if (!oldOps.has(key) && oldPaths.has(path)) {
      records.push({ kind: 'operation-added', breaking: false, anchor: key, detail: '' });
    }
  }

  records.sort((a, b) => (b.breaking - a.breaking) || a.anchor.localeCompare(b.anchor) || a.kind.localeCompare(b.kind));
  return records;
}

// ---------- CLI ----------

function main() {
  const args = process.argv.slice(2);
  const jsonIdx = args.indexOf('--json');
  const jsonOut = jsonIdx !== -1 ? args[jsonIdx + 1] : null;
  const files = args.filter((a, i) => a !== '--json' && (jsonIdx === -1 || i !== jsonIdx + 1));
  if (files.length !== 2) {
    console.error('Usage: node app/specdiff.js <old-spec.json> <new-spec.json> [--json <out.json>]');
    process.exit(1);
  }
  let oldSpec, newSpec;
  try {
    oldSpec = JSON.parse(readFileSync(files[0], 'utf8'));
    newSpec = JSON.parse(readFileSync(files[1], 'utf8'));
  } catch (e) {
    console.error(`Failed to read/parse spec: ${e.message}`);
    process.exit(1);
  }
  const records = diffSpecs(oldSpec, newSpec);
  const breaking = records.filter((r) => r.breaking);
  console.log(`specdiff: ${records.length} changes (${breaking.length} breaking)`);
  for (const r of records) {
    console.log(`  [${r.breaking ? 'BREAKING' : (r.warning ? 'warning ' : 'additive')}] ${r.kind}  ${r.anchor}${r.detail ? '  ' + r.detail : ''}`);
  }
  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({ generated_at: new Date().toISOString(), tool: 'mendapi-specdiff/0.1', records }, null, 2));
    console.log(`JSON written: ${jsonOut}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
