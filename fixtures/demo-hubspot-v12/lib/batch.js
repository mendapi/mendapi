// Batch and multi-language blog operations on the v12 surface. v13 moves
// the *Batch methods to cms.blogs.batchApi (dropping the suffix) and the
// language-group methods to cms.blogs.multiLanguageApi (all off the legacy
// blog-posts namespace).
const hubspot = require('@hubspot/api-client');

const client = new hubspot.Client({ accessToken: process.env.HUBSPOT_ACCESS_TOKEN });
const MIGRATION_HINT = 'v13 migration pending';

async function importPosts(inputs) {
  const created = await client.cms.blogs.blogPostsApi.createBatch({ inputs });
  console.warn(`${MIGRATION_HINT}: audit for cms.blogs.blogPostsApi.readBatch( usage per tenant`);
  return created;
}

async function readPosts(ids) {
  return client.cms.blogs.blogPostsApi.readBatch({ inputs: ids.map((id) => ({ id })) });
}

async function bulkUpdate(inputs) {
  await client.cms.blogs.blogPostsApi.updateBatch({ inputs });
}

async function bulkArchive(ids) {
  await client.cms.blogs.blogPostsApi.archiveBatch({ inputs: ids.map((id) => ({ id })) });
}

async function localize(postId, primaryId, language) {
  const variation = await client.cms.blogs.blogPostsApi.createLangVariation({
    id: primaryId,
    language,
  });
  await client.cms.blogs.blogPostsApi.attachToLangGroup({ id: postId, primaryId, language });
  await client.cms.blogs.blogPostsApi.setLangPrimary({ id: primaryId });
  return variation;
}

async function delocalize(postId, updates) {
  await client.cms.blogs.blogPostsApi.updateLangs(updates);
  await client.cms.blogs.blogPostsApi.detachFromLangGroup({ ids: [postId] });
}

module.exports = { importPosts, readPosts, bulkUpdate, bulkArchive, localize, delocalize };
