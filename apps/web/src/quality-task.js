import { useEffect, useRef, useState } from 'react';
import { isQualityTerminal, qualityApi } from './quality-api.js';

// The access token and all request lifetimes are scoped to this mounted tool.
export function useQualityTask() {
  const [report, setReport] = useState(null);
  const [phase, setPhase] = useState('idle');
  const [startedAt, setStartedAt] = useState(null);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const request = useRef(null);
  const task = useRef(null);
  const finished = useRef(true);
  useEffect(() => () => {
    generation.current += 1;
    request.current?.abort();
    if (task.current && !finished.current) qualityApi.cancel(task.current).catch(() => {});
    task.current = null;
  }, []);

  async function observe(handle, version, controller) {
    try {
      await qualityApi.watch(handle, snapshot => {
        if (version !== generation.current || controller.signal.aborted) return;
        finished.current = isQualityTerminal(snapshot.state);
        setReport(snapshot);
        setPhase(finished.current ? 'idle' : 'running');
      }, controller.signal);
    } catch (failure) {
      if (version !== generation.current || controller.signal.aborted) return;
      setError(failure.message);
      setPhase(finished.current ? 'idle' : 'disconnected');
    }
  }
  async function start(input, itemIds = [], onCreated) {
    const parent = task.current;
    const version = ++generation.current;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setError(''); setStartedAt(Date.now()); setPhase('creating');
    try {
      const ids = itemIds;
      const handle = ids.length && parent ? await qualityApi.retest(parent, ids, input, controller.signal) : await qualityApi.start(input, controller.signal);
      input = null;
      if (version !== generation.current || controller.signal.aborted) { qualityApi.cancel(handle).catch(() => {}); return; }
      task.current = handle; finished.current = false;
      onCreated?.();
      if (!ids.length) setReport(null);
      setPhase('running');
      await observe(handle, version, controller);
    } catch (failure) {
      if (version !== generation.current || controller.signal.aborted) return;
      setError(failure.message); setPhase('idle');
    }
  }
  async function cancel() {
    if (!task.current || finished.current) return;
    const version = ++generation.current;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setPhase('cancelling'); setError('');
    try {
      const snapshot = await qualityApi.cancel(task.current, controller.signal);
      if (version !== generation.current || controller.signal.aborted) return;
      setReport(snapshot); finished.current = isQualityTerminal(snapshot.state);
      setPhase(finished.current ? 'idle' : 'disconnected');
    } catch (failure) {
      if (version !== generation.current || controller.signal.aborted) return;
      setError(failure.message); setPhase('disconnected');
    }
  }
  function reconnect() {
    if (!task.current) return;
    const version = ++generation.current;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setError(''); setPhase('running');
    void observe(task.current, version, controller);
  }
  function reset() {
    generation.current += 1;
    request.current?.abort();
    if (task.current && !finished.current) qualityApi.cancel(task.current).catch(() => {});
    task.current = null; finished.current = true;
    setPhase('idle'); setError(''); setReport(null);
  }
  return { report, phase, startedAt, error, setError, start, cancel, reconnect, reset, active: phase !== 'idle', disconnected: phase === 'disconnected' };
}
