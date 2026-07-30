// Visits report renderer for the analytics dashboard. Includes a guard
// negative site: an unrelated TLS inventory object that uses the same
// key name but never talks to the analytics query surface via this file's
// sibling — the guard is file-scoped, so this file DOES hit the
// web-analytics marker and its dead reads are mended, while
// lib/tls-inventory.js (no marker) must stay untouched.
const { eventBreakdown } = require('../index.js');

async function visitsReport(rows) {
  // rows come from GET web-analytics visits/aggregate
  const table = rows.map((row) => ({
    country: row.country,
    dheCipherSuite: row.dheCipherSuite,
    visits: row.visits,
  }));
  const totalByCipher = {};
  let totalVisits = 0;
  for (const entry of table) {
    totalByCipher[entry.dheCipherSuite] = (totalByCipher[entry.dheCipherSuite] || 0) + entry.visits;
    totalVisits += entry.visits;
  }
  return { table, totalByCipher, totalVisits };
}

module.exports = { visitsReport, eventBreakdown };
