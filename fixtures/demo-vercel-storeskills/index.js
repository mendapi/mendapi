// Marketplace store provisioning against api.vercel.com
const API = 'https://api.vercel.com/v1/storage/stores/integration/direct';

async function provisionStore(payload, token) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const { store } = await res.json();
  // legacy single-URL read of the product guide field
  const skillUrl = store.product.agentSkillUrl;
  if (skillUrl) {
    console.log(`agent guide: ${skillUrl}`);
  }
  return store;
}

function describeProduct(store) {
  const guide = store?.product?.agentSkillUrl ?? 'no guide published';
  return { name: store.product.name, guide };
}

module.exports = { provisionStore, describeProduct };
