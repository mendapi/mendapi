// Custom client subclass. v7.0.0 replaced the base class and moved it from
// the core module to the client module.
// Upgrade note: subclasses of APIClient must move to the new base (tripwire, keep as-is).
import { APIClient } from 'cloudflare/core';

const UPGRADE_WARNING = 'custom transports extending APIClient must migrate before v7';

export class AuditedClient extends APIClient {
  constructor(options) {
    super(options);
    this.auditLog = [];
    this.deprecationHint = `${UPGRADE_WARNING}: grep for APIClient subclasses in this repo`;
  }
}
