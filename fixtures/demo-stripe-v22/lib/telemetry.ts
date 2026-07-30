// Guard negative: this module never imports the stripe package. Its local
// namespace happens to expose the same qualified names — the pack must not
// rewrite anything in this file.
namespace Stripe {
  export class HttpClient {
    getClientName() {
      return 'local-telemetry';
    }
  }
  export class HttpClientResponse {}
}

export class TelemetryClient extends Stripe.HttpClient {
  getClientName() {
    return 'telemetry';
  }
}

export class TelemetryResponse extends Stripe.HttpClientResponse {}
