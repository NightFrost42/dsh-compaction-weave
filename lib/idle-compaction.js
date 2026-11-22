// Resume-time compaction uses durable conversation activity, not a provider TTL
// claim. No timer, credentials, or process-local last-seen timestamp is needed.
import { isExternalFoldEvent, isReferenceContextKind } from './source-provenance.js';
import { isReferencePrefixOnly, isSystemReminderOnly } from './instruction-source.js';

export function isUserInput(message) {
  if (message?.role !== 'user') return false;
  const kind = message.source?.kind;
  if (kind && kind !== 'user') return false;
  if (isReferenceContextKind(kind)) return false;
  if (message.externalFold === true) return false;
  if (isSystemReminderOnly(message)) return false;
  if (isReferencePrefixOnly(message)) return false;
  return true;
}

const validTime = value => Number.isSafeInteger(value) && value >= 0;

/** Return the expired interval only at the first step of a new user turn.
 * Inbox inserts, startup events and runtime reminders must not refresh it.
 * A queued message's arrival bounds the interval: time spent preparing a step
 * or waiting behind other work is not idle time before that message arrived.
 */
export function idleResumeDue(session, messages, minutes, now = Date.now()) {
  if (!Number.isSafeInteger(minutes) || minutes <= 0 || !validTime(now)) return null;
  const incoming = (Array.isArray(messages) ? messages : []).filter(isUserInput);
  if (!incoming.length || !Number.isSafeInteger(session?.seq) || typeof session.eventAt !== 'function') return null;
  if (incoming.some(message => typeof message.id !== 'string' || !message.id)) return null;
  const ids = new Set(incoming.map(message => message.id).filter(id => typeof id === 'string' && id));
  const arrivals = new Map();
  let resumedTurn = false;
  let arrivedAt = now;
  let compactedAfterActivity = null;
  let lastActivity = null;
  for (let seq = session.seq - 1; seq >= 0; seq--) {
    const event = session.eventAt(seq);
    if (!event) continue;
    if (event.type === 'agent/inbox/spliced') {
      for (const message of event.data?.inserted ?? []) {
        if (!ids.has(message.id)) continue;
        // Invalid/future arrival times cannot prove an idle interval.
        if (!validTime(event.time) || event.time > now) return null;
        arrivedAt = Math.min(arrivedAt, event.time);
        arrivals.set(message.id, event.time);
      }
      // Older inserts can only move this upper bound earlier. Once the gap is
      // too short, neither a requeue nor a missing arrival can make it expire.
      if (lastActivity && arrivedAt - lastActivity.time <= minutes * 60_000) return null;
      continue;
    }
    if (lastActivity) continue; // Older events can locate arrivals, not newer activity.
    if (event.type === 'compaction/end' && compactedAfterActivity === null) compactedAfterActivity = !event.data?.error;
    if (!resumedTurn) {
      if (event.type === 'turn/start') { resumedTurn = true; continue; }
      // Input injected during an active tool/model loop is not a resumed chat.
      if (['step/start', 'turn/end', 'assistant/message', 'tool/call', 'tool/result'].includes(event.type)) return null;
      continue;
    }
    if (isExternalFoldEvent(event, session)) continue;
    const activity = event.type === 'assistant/message' || event.type === 'tool/call' || event.type === 'tool/result' ||
      (event.type === 'user/message' && isUserInput(event.data));
    if (!activity) continue;
    // There has been no new conversation work since a successful compaction.
    if (compactedAfterActivity || !validTime(event.time)) return null;
    lastActivity = {seq, time:event.time};
    // A short (or backwards) interval is conclusive without scanning the older
    // log. Expired intervals still need the original inserts for every input.
    if (arrivedAt - lastActivity.time <= minutes * 60_000) return null;
  }
  // Scan past activity for the original insert of the same message id. A failed
  // pre-step requeues that id later; the retry must not invent a longer gap.
  if (!lastActivity || arrivals.size !== ids.size || lastActivity.time > arrivedAt) return null;
  const elapsedMs = arrivedAt - lastActivity.time;
  return elapsedMs > minutes * 60_000 ? { lastActivitySeq:lastActivity.seq, lastActivityAt:lastActivity.time, arrivedAt, elapsedMs } : null;
}
