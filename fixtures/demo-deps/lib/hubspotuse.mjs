// HubSpot sdk-call fixture: chains resolved through the @hubspot/api-client
// binding must join the hubspot-blogposts-api-move pack via `mendapi deps
// --match`, and already-migrated chains (basicApi) must never join.
import { Client } from '@hubspot/api-client';

const hubspot = new Client({ accessToken: process.env.HUBSPOT_ACCESS_TOKEN });

export async function archivePost(postId) {
  // pre-migration form: covered by the pack's chains metadata
  return hubspot.cms.blogs.blogPostsApi.archive(postId);
}

export async function createPost(body) {
  // already-migrated form: same provider, must never join the pack
  return hubspot.cms.blogs.basicApi.create(body);
}
