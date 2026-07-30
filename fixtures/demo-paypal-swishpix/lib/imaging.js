// Guard negative site: an internal image-processing helper that happens to
// use a `pix` key and a `swish` transition name on its own objects. There is
// no PayPal Orders API context in this file, so the mend must leave every
// line byte-identical.
const renderDefaults = {
  pix: { density: 2, format: 'png' },
  swish: { duration: 300, easing: 'ease-out' },
};

function renderThumbnail(overrides) {
  const config = { ...renderDefaults, ...overrides };
  if (config.pix.density > 1) config.retina = true;
  return config;
}

module.exports = { renderThumbnail, renderDefaults };
