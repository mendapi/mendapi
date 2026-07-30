// Referral phone directory helper. Talks to the PayPal Partner Referrals
// v2 surface (api-m.paypal.com, /v2/customer/partner-referrals) - both
// file-level guards pass. The destructuring pattern below binds the
// withdrawn tags leaf off an anchored phones[0] element chain, but the
// binding is REFERENCED in the return value: the reference count is the
// only defence, and this file must come back byte-identical.

function phoneTags(data) {
  const { tags, national_number } = data.referral_data.business_entity.phones[0];
  return { tags, national_number };
}

module.exports = { phoneTags };
