// Demo deployment tooling talking to the Vercel project API.
// The extended-max-duration toggle was withdrawn upstream in v1.28.0
// (request schemas reject unknown props), so the flag must be deleted
// from payloads and every read of it removed.
const TOKEN = process.env.VERCEL_TOKEN;
const BASE = 'https://api.vercel.com';

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`vercel api ${res.status}`);
  return res.json();
}

async function createProject(name) {
  return api('POST', '/v11/projects', {
    name,
    resourceConfig: { enableFunctionsExtendedMaxDuration: true, functionDefaultMemoryType: 'standard' },
  });
}

async function enableLongFunctions(idOrName) {
  return api('PATCH', `/v9/projects/${idOrName}`, {
    resourceConfig: { enableFunctionsExtendedMaxDuration: true },
  });
}

async function auditProject(idOrName) {
  const project = await api('GET', `/v9/projects/${idOrName}`);
  const { enableFunctionsExtendedMaxDuration, functionDefaultMemoryType } = project.resourceConfig;
  const flags = {
    memory: functionDefaultMemoryType,
    extendedDuration: enableFunctionsExtendedMaxDuration === true,
  };
  return flags;
}

module.exports = { createProject, enableLongFunctions, auditProject };
