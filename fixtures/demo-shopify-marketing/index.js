// Demo app recording marketing engagement metrics via the Shopify Admin API.
// Shopify deprecated the cumulative flag on marketingEngagementCreate;
// integrations should send non-cumulative engagements without the argument.
const SHOP = process.env.SHOPIFY_SHOP_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const ENDPOINT = `https://${SHOP}/admin/api/2026-04/graphql.json`;

const ENGAGEMENT_MUTATION = `
  mutation CreateEngagement($activityId: ID!, $engagement: MarketingEngagementInput!, $isCumulative: Boolean!) {
    marketingEngagementCreate(
      marketingActivityId: $activityId
      marketingEngagement: $engagement
    ) {
      marketingEngagement {
        occurredOn
        isCumulative
      }
      userErrors {
        field
        message
      }
    }
  }
`;

async function recordEngagement(activityId, metrics) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': TOKEN,
    },
    body: JSON.stringify({
      query: ENGAGEMENT_MUTATION,
      variables: {
        activityId,
        isCumulative: false,
        engagement: {
          occurredOn: metrics.date,
          impressionsCount: metrics.impressions,
          clicksCount: metrics.clicks,
          isCumulative: false,
        },
      },
    }),
  });
  const json = await res.json();
  return json.data.marketingEngagementCreate;
}

module.exports = { recordEngagement };
