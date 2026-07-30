// Guard negative site: an internal batch-job scheduler that happens to
// use the exact same flag name on its own config object. There is no
// deployment-platform API context in this file, so the mend must leave
// every line byte-identical.
const jobDefaults = {
  retries: 3,
  enableFunctionsExtendedMaxDuration: true,
  queue: 'default',
};

function scheduleJob(name, overrides) {
  const config = { ...jobDefaults, ...overrides };
  if (config.enableFunctionsExtendedMaxDuration) {
    config.timeoutMs = 900000;
  }
  return { name, config };
}

module.exports = { scheduleJob, jobDefaults };
