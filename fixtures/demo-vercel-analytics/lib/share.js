// AST-track positive: multi-line destructuring off an analytics row —
// dheCipherSuite is a dead binding (the line-level rule honestly keeps
// bare pattern entry lines), the AST pass should excise it and keep the
// surviving visits binding. rows come from GET web-analytics
// visits/aggregate.
function visitShare(rows) {
  const {
    dheCipherSuite,
    visits,
  } = rows[0];
  return visits;
}

module.exports = { visitShare };
