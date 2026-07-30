// Internal documentation registry. No PayPal context: reads of the
// information_link field on internal catalog entries must never be
// rewritten by the migration pack (file-level guard negative site).
function describeEntry(entry) {
  return {
    title: entry.title,
    docs: entry.information_link,
    updated: entry.updated_at,
  };
}

function hasDocs(entry) {
  if (entry.information_link) return true;
  return false;
}

module.exports = { describeEntry, hasDocs };
