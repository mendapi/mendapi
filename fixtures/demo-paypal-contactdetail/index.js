// Sample integration: PayPal Partner Referrals v2 onboarding sync.
// Talks to api-m.paypal.com and builds POST /v2/customer/partner-referrals
// payloads, then reads the GET referral response.

const BASE = 'https://api-m.paypal.com';

async function createReferral(client, owner) {
  return client.post(`${BASE}/v2/customer/partner-referrals`, {
    individual_owners: [
      {
        names: owner.names,
        phones: [{
          country_code: '1',
          national_number: owner.phone,
          type: 'MOBILE',
          contact_name: owner.displayName,
          primary_mobile: true,
        }],
        addresses: owner.addresses,
      },
    ],
  });
}

async function summarizeReferral(client, referralId) {
  const res = await client.get(`${BASE}/v2/customer/partner-referrals/${referralId}`);
  const data = res.body;
  const summary = {
    ownerPhone: data.referral_data.individual_owners[0].phones[0].national_number,
    ownerPhoneType: data.referral_data.individual_owners[0].phones[0].type,
    ownerContact: data.referral_data.individual_owners[0].phones[0].contact_name,
    bizCity: data.referral_data.business_entity.addresses[0].admin_area_2,
    bizCountry: data.referral_data.business_entity.addresses[0].country_code,
    bizPrimaryAddr: data.referral_data.business_entity.addresses[0].primary,
  };
  if (data.referral_data.individual_owners[0].addresses[0].inactive) summary.staleAddress = true;
  console.log('tags', data.referral_data.business_entity.phones?.[0]?.tags);
  return summary;
}

module.exports = { createReferral, summarizeReferral };
