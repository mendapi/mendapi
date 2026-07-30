// Guard negative file: a local registry whose member chain happens to end in
// .values.get / .values.delete but is NOT the cloudflare SDK. This file has no
// cloudflare import, so the pack must leave every byte unchanged.
const registry = {
  namespaces: {
    values: {
      get(nsId, key) {
        return `${nsId}:${key}`;
      },
      delete(nsId, key) {
        return `${nsId}:${key}:gone`;
      },
    },
  },
};

export function lookup(nsId, key) {
  return registry.namespaces.values.get(nsId, key);
}

export function evict(nsId, key) {
  return registry.namespaces.values.delete(nsId, key);
}
