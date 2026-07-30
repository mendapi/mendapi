// Notifier built on @slack/webhook v7: branches on string error codes
// from the SDK enum instead of the v8 Error subclasses.
const { IncomingWebhook, ErrorCode } = require('@slack/webhook');

const webhook = new IncomingWebhook(process.env.SLACK_WEBHOOK_URL);

async function notify(text) {
  try {
    await webhook.send({ text });
    return true;
  } catch (error) {
    if (error.code === ErrorCode.HTTPError) {
      console.error('Webhook endpoint returned an error status');
      return false;
    }
    if (error.code === ErrorCode.RequestError) {
      console.error('Could not reach the webhook endpoint');
      return false;
    }
    throw error;
  }
}

module.exports = { notify };
