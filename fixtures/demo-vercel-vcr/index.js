// Container registry maintenance jobs using the Vercel SDK VCR client.
const { Vercel } = require('@vercel/sdk');

const vercel = new Vercel({ bearerToken: process.env.VERCEL_TOKEN });

async function inspectImage(repo, imageId, teamId) {
  // single-image fetch: the typed option key is the breakage surface
  const img = await vercel.vcr.getRepositoryImage({ idOrName: repo, imageId, teamId });
  return { tags: img.tags, history: img.dockerfileHistory };
}

async function inspectImageBySlug(repo, id) {
  const img = await vercel.vcr.getRepositoryImage({
    idOrName: repo,
    imageId: id,
    slug: 'acme',
  });
  return img;
}

async function pruneImage(repo, imageId) {
  // the DELETE operation keeps its original path parameter upstream,
  // so this call site must stay untouched by the mend
  await vercel.vcr.deleteRepositoryImage({ idOrName: repo, imageId });
  return true;
}

module.exports = { inspectImage, inspectImageBySlug, pruneImage };
