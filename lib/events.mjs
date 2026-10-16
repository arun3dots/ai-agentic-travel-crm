// Central Event Bus for decoupled module communication (Slide 21)
import EventEmitter from 'node:events';
import { logAudit } from './audit.mjs';

class OfficeEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
  }

  /**
   * Broadcast an event across the office system and log it.
   * @param {string} eventName e.g. 'quotation.sent', 'booking.created'
   * @param {object} payload
   */
  async broadcast(eventName, payload = {}) {
    console.log(`[event-bus] 📢 ${eventName}`, payload.leadId ? `lead:${payload.leadId}` : '');
    
    // Asynchronously log event to audit trail if organizationId is present
    if (payload.organizationId) {
      logAudit({
        action: `event.${eventName}`,
        targetType: payload.targetType || 'Event',
        targetId: payload.targetId || payload.leadId || payload.bookingId || null,
        metadata: { ...payload, emittedAt: new Date().toISOString() },
      }).catch(err => console.error(`[event-bus] audit error for ${eventName}:`, err.message));
    }

    // Trigger registered module listeners
    this.emit(eventName, payload);
    this.emit('*', { event: eventName, ...payload });
  }
}

export const bus = new OfficeEventBus();

