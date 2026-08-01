// Demo Workers AI consumer still on the removed omni-/ray- prefixed model
// slugs. The 2026-03-31 Cloudflare OAS drop removed these alias slugs; each
// has a canonical successor that existed on both sides of the change.
export default {
  async fetch(request, env) {
    const { text } = await request.json();
    // omni- alias slug: canonical successor is the bare bge slug.
    const embedding = await env.AI.run('@cf/baai/omni-bge-base-en-v1.5', { text });
    // omni- alias on the detection model: successor is the nonomni- slug.
    const boxes = await env.AI.run('@cf/facebook/omni-detr-resnet-50', { image: text });
    // Already migrated: canonical slug must be left untouched (idempotency
    // / partial-migration safety).
    const large = await env.AI.run('@cf/baai/bge-large-en-v1.5', { text });
    return Response.json({ embedding, boxes, large });
  },
};
