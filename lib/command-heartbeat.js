import { AsyncLocalStorage } from 'node:async_hooks';

// Scope the response to its real admitted HTTP invocation without reading or
// replacing its body, signal, final status, headers or RPC result.
const requests = new AsyncLocalStorage();
export const COMMAND_HEARTBEAT_MS = 15000;

export function createCommandHeartbeatScope({intervalMs = COMMAND_HEARTBEAT_MS} = {}) {
  const active = new Set();
  let disposed = false;
  return {
    handle(request, response, next) {
      if (disposed || request?.method !== 'POST' || request.url?.split('?')[0] !== '/api/commands/execute') return next();
      return requests.run({response, intervalMs, active, available:()=>!disposed}, next);
    },
    dispose() {
      disposed = true;
      for (const stop of [...active]) stop();
    },
  };
}

export function installCommandHeartbeat(ctx) {
  // Minimal/non-web hosts may expose only the engine configuration seam.
  if (typeof ctx?.on !== 'function' || typeof ctx?.effect !== 'function') return;
  const scope = createCommandHeartbeatScope();
  const remove = ctx.on('connection/request', (request,response,next)=>scope.handle(request,response,next), {global:true});
  ctx.effect(()=>()=>{scope.dispose();if(typeof remove==='function')remove();});
}

/** Only plugin-owned compaction commands opt in, after native RPC admission. */
export async function withCommandHeartbeat(invocation, run) {
  const current = requests.getStore();
  if (!current?.available() || invocation?.signal?.aborted || invocation?.rawInput?.trim()) return run();
  const {response,intervalMs,active} = current;
  if (typeof response?.writeProcessing !== 'function' || response.headersSent || response.destroyed || response.writableEnded) return run();
  let timer, stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    response.off('close',stop);
    response.off('finish',stop);
    invocation.signal?.removeEventListener('abort',stop);
    active.delete(stop);
  };
  const pulse = () => {
    if (response.destroyed || response.writableEnded || response.headersSent || invocation.signal?.aborted) {stop();return;}
    // 102 is informational: it keeps the relay's header wait alive without
    // committing a 200 response or inserting bytes into the JSON envelope.
    try { response.writeProcessing(); } catch { stop(); }
  };
  active.add(stop);
  response.once('close',stop);
  response.once('finish',stop);
  invocation.signal?.addEventListener('abort',stop,{once:true});
  timer = setInterval(pulse,intervalMs);
  timer.unref?.();
  pulse();
  try { return await run(); } finally { stop(); }
}
