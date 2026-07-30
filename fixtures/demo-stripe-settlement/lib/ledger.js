// Guard negative site: an internal treasury ledger with no Stripe
// context in the file. The same property name lives on its own config
// object here, so the mend must leave every line byte-identical.
const ledgerDefaults = {
  region: 'us',
  preferred_settlement_speed: 'standard',
};

function planSettlement(overrides) {
  const config = { ...ledgerDefaults, ...overrides };
  if (config.preferred_settlement_speed === 'fastest') {
    config.cutoffHour = 14;
  }
  return config;
}

module.exports = { planSettlement, ledgerDefaults };
