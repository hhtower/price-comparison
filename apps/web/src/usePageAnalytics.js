import { useEffect } from 'react';
import { startPageVisit } from './analytics.js';
export function usePageAnalytics(page) {
  useEffect(() => {
    let stop;
    // StrictMode's throwaway effect is cancelled before it can record a visit.
    const timer = window.setTimeout(() => { stop = startPageVisit(page); }, 0);
    return () => { window.clearTimeout(timer); stop?.(); };
  }, [page]);
}
