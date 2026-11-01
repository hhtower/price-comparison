import { useEffect } from 'react';
import { startPageVisit, trackUsage } from './analytics.js';
export function usePageAnalytics(page, entryAction) {
  useEffect(() => {
    if (!page) return undefined;
    let stop;
    // StrictMode's throwaway effect is cancelled before it can record a visit.
    const timer = window.setTimeout(() => { stop = startPageVisit(page); if (entryAction) trackUsage(entryAction); }, 0);
    return () => { window.clearTimeout(timer); stop?.(); };
  }, [page, entryAction]);
}
