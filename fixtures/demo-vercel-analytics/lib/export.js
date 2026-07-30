// AST-track negative: the alias binding is referenced after the pattern,
// so removeDestructuredProperty must leave both lines exactly as written
// even though this file carries the web-analytics marker.
// rows come from GET web-analytics events/aggregate
function exportRow(row) {
  const { dheCipherSuite: suite, country } = row;
  return { suite, country };
}

module.exports = { exportRow };
