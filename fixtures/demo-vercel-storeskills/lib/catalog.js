// Internal product catalog for an unrelated in-house marketplace. This
// module has no cloud-platform context at all, so the mend must leave it
// byte-identical.
const listings = [
  { sku: 'starter', agentSkillUrl: 'https://docs.internal/starter-guide' },
  { sku: 'pro', agentSkillUrl: 'https://docs.internal/pro-guide' },
];

function guideFor(sku) {
  const item = listings.find((l) => l.sku === sku);
  return item ? item.agentSkillUrl : null;
}

module.exports = { listings, guideFor };
