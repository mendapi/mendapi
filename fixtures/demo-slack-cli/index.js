// Slack CLI project tooling: validates the hooks config before deploys.
const { readFileSync, existsSync } = require('node:fs');

function loadHooksConfig() {
  const raw = readFileSync('slack.json', 'utf8');
  return JSON.parse(raw);
}

function hasHooksConfig() {
  return existsSync('./slack.json');
}

function main() {
  if (!hasHooksConfig()) {
    console.error('missing hooks config');
    process.exit(1);
  }
  const config = loadHooksConfig();
  console.log(Object.keys(config.hooks || {}).join(', '));
}

main();
