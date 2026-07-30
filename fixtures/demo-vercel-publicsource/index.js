// Demo dashboard tooling talking to the Vercel project API.
// The source-visibility field was dropped from every project response
// schema upstream in v1.28.0 (the request side still accepts it but marks
// it deprecated and ignored), so reads and writes of it must be deleted.
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
    publicSource: true,
    framework: 'nextjs',
  });
}

async function markSourcePrivate(idOrName) {
  return api('PATCH', `/v9/projects/${idOrName}`, {
    publicSource: false,
  });
}

async function describeProject(idOrName) {
  const project = await api('GET', `/v9/projects/${idOrName}`);
  const { publicSource, name, framework } = project;
  const summary = {
    name,
    framework,
    sourceVisible: publicSource === true,
  };
  if (publicSource) summary.badge = 'public';
  return summary;
}

async function listVisibility() {
  const { projects } = await api('GET', '/v10/projects');
  return projects.map((p) => ({ name: p.name, publicSource: p.publicSource }));
}

module.exports = { createProject, markSourcePrivate, describeProject, listVisibility };
