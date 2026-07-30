// Guard negative: an in-house inventory registry that never touches the
// cloudflare package. Its same-named lookup methods must stay byte-identical
// after the mend runs.
const inventory = {
  records: new Map(),
  getByIds(ids) {
    return ids.map((id) => this.records.get(id)).filter(Boolean);
  },
};

export function lookupLocal(localIds) {
  return inventory.getByIds(localIds);
}
