// Payment service wiring a custom transport into stripe-node.
import Stripe from 'stripe';

// Custom HTTP client typed against the stripe-node v22 surface. After
// v22.3.1 the exported type is an interface, so the class clause below is
// the breakage site this repo needs mended.
class InstrumentedClient extends Stripe.HttpClient {
  getClientName() {
    return 'instrumented';
  }

  makeRequest(
    host: string,
    port: string,
    path: string,
    method: string,
    headers: Record<string, string>,
    requestData: string,
    protocol: string,
    timeout: number,
  ) {
    return dispatch(host, port, path, method, headers, requestData, protocol, timeout);
  }
}

class InstrumentedResponse extends Stripe.HttpClientResponse {
  getStatusCode() {
    return this.status;
  }

  private status = 200;
}

// Already-migrated class: carries an implements clause, the rule must
// leave this line byte-for-byte untouched.
class MigratedClient implements Stripe.HttpClient {
  getClientName() {
    return 'migrated';
  }

  makeRequest() {
    return Promise.reject(new Error('not wired'));
  }
}

declare function dispatch(...args: unknown[]): Promise<InstrumentedResponse>;

export const stripe = new Stripe(process.env.STRIPE_KEY ?? '', {
  httpClient: new InstrumentedClient(),
});
