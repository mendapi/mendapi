// Raw REST caller: Workers AI model slugs also appear in /ai/run/ URLs.
const CF_API = 'https://api.cloudflare.com/client/v4';

export async function summarize(accountId, token, text) {
  // ray- alias slug: canonical successor is the bare bge slug.
  const emb = await fetch(`${CF_API}/accounts/${accountId}/ai/run/@cf/baai/ray-bge-large-en-v1.5`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ text }),
  });
  // omni- alias on the embedding model: successor drops the prefix.
  const gem = await fetch(`${CF_API}/accounts/${accountId}/ai/run/@cf/google/omni-embeddinggemma-300m`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ text }),
  });
  return { emb: await emb.json(), gem: await gem.json() };
}
