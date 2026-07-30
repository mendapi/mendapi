// Guard negative site: an internal static-site generator config that
// happens to use the exact same field name on its own settings object.
// There is no deployment-platform API context in this file, so the mend
// must leave every line byte-identical.
const siteDefaults = {
  theme: 'minimal',
  publicSource: true,
  outputDir: 'dist',
};

function buildSite(overrides) {
  const config = { ...siteDefaults, ...overrides };
  if (config.publicSource) {
    config.footerLink = 'https://example.com/source';
  }
  return config;
}

module.exports = { buildSite, siteDefaults };
