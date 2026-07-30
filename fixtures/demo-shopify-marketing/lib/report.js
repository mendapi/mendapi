// Batch reporter: pushes daily engagement rows to marketingEngagementCreate.
const { buildQuery } = require('./query');

const DAILY_MUTATION = `
  mutation DailyEngagement($activityId: ID!, $engagement: MarketingEngagementInput!) {
    marketingEngagementCreate(marketingActivityId: $activityId, marketingEngagement: $engagement) {
      marketingEngagement { occurredOn }
      userErrors { field message }
    }
  }
`;

function buildVariables(activityId, row) {
  return {
    activityId,
    engagement: { occurredOn: row.date, isCumulative: true, adSpend: { amount: row.spend, currencyCode: 'USD' } },
  };
}

async function reportDaily(client, activityId, rows) {
  const results = [];
  for (const row of rows) {
    const payload = { query: DAILY_MUTATION, variables: buildVariables(activityId, row) };
    results.push(await client.graphql(payload));
  }
  return results;
}

module.exports = { reportDaily, buildVariables, DAILY_MUTATION };
