// Demo app using the legacy @slack/web-api v7 error-handling style.
// Error branching relies on comparing string codes from the SDK enum,
// which the v8 SDK replaces with proper Error subclasses.
const { WebClient, ErrorCode } = require('@slack/web-api');

const client = new WebClient(process.env.SLACK_BOT_TOKEN);

async function postMessage(channel, text) {
  try {
    return await client.chat.postMessage({ channel, text });
  } catch (error) {
    if (error.code === ErrorCode.PlatformError) {
      console.error('Slack rejected the call:', error.data);
      return null;
    }
    if (error.code === ErrorCode.RateLimitedError) {
      console.warn('Rate limited, retry after', error.retryAfter);
      return null;
    }
    if (error.code === ErrorCode.RequestError) {
      console.error('Network failure talking to Slack');
      return null;
    }
    throw error;
  }
}

async function ensureOk(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error.code !== ErrorCode.HTTPError) throw error;
    console.error('Slack returned a non-200 status');
    return null;
  }
}

module.exports = { postMessage, ensureOk };
