// Capacity limits reader for the Vercel project API.
// The extended-max-duration flag was withdrawn upstream in v1.28.0, so the
// dead binding below must be removed while the surviving sibling stays.
const BASE = 'https://api.vercel.com';

async function memoryTier(client, idOrName) {
  const proj = await client.get(`${BASE}/v9/projects/${idOrName}`);
  const {
    enableFunctionsExtendedMaxDuration,
    functionDefaultMemoryType,
  } = proj.resourceConfig;
  return `memory tier: ${functionDefaultMemoryType}`;
}

module.exports = { memoryTier };
