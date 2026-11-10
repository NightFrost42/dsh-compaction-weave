// AbortSignal.any compatibility without losing caller cancellation on older Node runtimes.
export function combineSignals(signals) {
  const controller = new AbortController();
  const subscriptions = [];
  const dispose = () => { for (const [signal, listener] of subscriptions) signal.removeEventListener('abort', listener); subscriptions.length = 0; };
  for (const signal of signals.filter(Boolean)) {
    const listener = () => { if (!controller.signal.aborted) controller.abort(signal.reason); dispose(); };
    if (signal.aborted) { listener(); break; }
    signal.addEventListener('abort', listener, { once: true });
    subscriptions.push([signal, listener]);
  }
  return { signal: controller.signal, dispose };
}
