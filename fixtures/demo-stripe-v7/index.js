// Demo app entry point.
const { createCustomer } = require('./lib/billing');

async function main() {
  const customer = await createCustomer('demo@example.com');
  console.log(customer.id);
}

main().catch((err) => { console.error(err); process.exit(1); });
