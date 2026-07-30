// Demo dashboard consuming the Vercel Web Analytics query API.
// The TLS dimension was discontinued upstream in v1.28.9 with no
// successor field, so every read of it must be deleted.
const TOKEN = process.env.VERCEL_TOKEN;
const BASE = 'https://api.vercel.com/v1/query/web-analytics';

async function query(path, params) {
  const url = `${BASE}/${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`web-analytics query ${res.status}`);
  return res.json();
}

const DIMENSIONS = ['browser', 'dheCipherSuite', 'country'];

async function eventBreakdown(projectId) {
  const { data } = await query('events/aggregate', { projectId, groupBy: DIMENSIONS.join(',') });
  const stats = {};
  for (const row of data) {
    const { dheCipherSuite, browser } = row;
    stats[dheCipherSuite] = (stats[dheCipherSuite] || 0) + 1;
    stats[browser] = (stats[browser] || 0) + 1;
  }
  return stats;
}

module.exports = { eventBreakdown, DIMENSIONS };
