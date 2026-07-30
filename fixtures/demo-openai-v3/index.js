// Demo app entry point.
const { summarize } = require('./lib/ai');

async function main() {
  const result = await summarize('Hello world');
  console.log(result);
}

main().catch((err) => { console.error(err); process.exit(1); });
