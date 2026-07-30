// Board-minutes snapshots for PayPal Partner Referrals v2
// (https://api-m.paypal.com/v2/customer/partner-referrals). The
// office_bearers binding below is still referenced, so even though its
// pattern is anchored to the business_entity chain the AST pass must
// leave it alone.
function minutesSnapshot(data) {
  const { office_bearers, names } = data.referral_data.business_entity;
  return { office_bearers, names };
}

module.exports = { minutesSnapshot };
