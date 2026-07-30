// Demo app using the HubSpot API client v12 blog surface. In v13 every
// method on the legacy blog-posts namespace moved to basicApi / batchApi /
// multiLanguageApi (release notes: hubspot-api-nodejs 13.0.0).
const hubspot = require('@hubspot/api-client');

const client = new hubspot.Client({ accessToken: process.env.HUBSPOT_ACCESS_TOKEN });

async function publishPost(postId) {
  const post = await client.cms.blogs.blogPostsApi.getById(postId);
  await client.cms.blogs.blogPostsApi.pushLive(postId);
  // Docs note: cms.blogs.blogPostsApi.getById({...}) was the v12 namespace.
  return post;
}

async function draftWorkflow(postId, patch) {
  await client.cms.blogs.blogPostsApi.updateDraft(postId, patch);
  await client.cms.blogs.blogPostsApi.schedule({ id: postId, publishDate: patch.publishDate });
  console.log('callers still on cms.blogs.blogPostsApi.pushLive( must upgrade to v13');
}

async function clonePost(postId, name) {
  return client.cms.blogs.blogPostsApi.callClone({ id: postId, cloneName: name });
}

async function retirePost(postId) {
  await client.cms.blogs.blogPostsApi.resetDraft(postId);
  await client.cms.blogs.blogPostsApi.archive(postId);
}

module.exports = { publishPost, draftWorkflow, clonePost, retirePost };
