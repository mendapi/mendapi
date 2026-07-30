// Asset upload helper. v7.0.0 removed the static file helper export from the
// SDK package; native node streams are the documented replacement.
import Cloudflare, { fileFromPath } from 'cloudflare';

const client = new Cloudflare({ apiToken: process.env.CLOUDFLARE_API_TOKEN });

export async function uploadBundle(accountId, scriptName) {
  const file = await fileFromPath('./dist/bundle.js');
  return client.workers.scripts.update(scriptName, {
    account_id: accountId,
    files: { 'bundle.js': file },
  });
}
