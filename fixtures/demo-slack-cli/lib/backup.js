// Backup tooling that must survive the pack untouched: these paths are not
// the Slack CLI hooks config, they only share a suffix with its filename.
const { copyFileSync } = require('node:fs');

const EXPORT_TARGETS = [
  'backups/team-slack.json',
  'backups/workspace-slack.json.bak',
];

function exportSnapshots(payload) {
  for (const target of EXPORT_TARGETS) {
    copyFileSync(payload, target);
  }
  return EXPORT_TARGETS.length;
}

module.exports = { exportSnapshots };
