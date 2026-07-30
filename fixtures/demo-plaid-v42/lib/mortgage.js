// Guard negative site: in-house mortgage helpers with no plaid import. The
// hyphenated phrase below describes a local mortgage product and must never
// be rewritten by the plaid pack.
const MORTGAGE_PRODUCTS = {
  'interest-only': { termYears: 10, principalDeferred: true },
  amortizing: { termYears: 30, principalDeferred: false },
};

function mortgageTerm(kind) {
  const product = MORTGAGE_PRODUCTS[kind] || MORTGAGE_PRODUCTS.amortizing;
  return product.termYears;
}

module.exports = { MORTGAGE_PRODUCTS, mortgageTerm };
