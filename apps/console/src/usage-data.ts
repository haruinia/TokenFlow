import { useCallback, useEffect, useRef, useState } from 'react';
import { requestJSON } from './request';
import type {UsageCoverage} from '../../../packages/core/src/local-usage';
import { rangeDays, type RangeId, type UsageRow } from './usage-model';

const rangeKey = 'token-flow.usage.range';
const readRange = (): RangeId => { try { const value = localStorage.getItem(rangeKey); return value === 'today' || value === '7d' || value === '30d' || value === 'all' ? value : '7d'; } catch { return '7d'; } };

/** Persistent per-day statistics for the chosen window; the chosen window is remembered across pages. */
export function useUsage(enabled = true) {
  const [range, setRangeState] = useState<RangeId>(readRange);
  const [state, setState] = useState<{ rows: UsageRow[]; nativeRows:UsageRow[]; combinedRows:UsageRow[]; allRows:UsageRow[]; coverage:UsageCoverage[]; scanning:boolean; generatedAt?:string; loaded: boolean; error: string; warning: string }>({ rows: [], nativeRows:[], combinedRows:[], allRows:[], coverage:[], scanning:false, loaded: false, error: '', warning: '' });
  const version = useRef(0);
  const setRange = useCallback((next: RangeId) => { setRangeState(next); try { localStorage.setItem(rangeKey, next); } catch { /* Only remembers the window. */ } }, []);
  const load = useCallback(async () => {
    const mine = ++version.current;
    try {
      const result = await requestJSON<{rows:UsageRow[];nativeRows:UsageRow[];combinedRows:UsageRow[];allRows:UsageRow[];coverage:UsageCoverage[];scanning:boolean;generatedAt?:string;warning?:string}>(`/api/usage/overview?days=${rangeDays(range)}`);
      if (mine === version.current) setState({...result,loaded:true,error:'',warning:result.warning??''});
    } catch {
      if (mine === version.current) setState(previous => ({ ...previous, error: '暂时无法读取用量统计，请检查本地服务。' }));
    }
  }, [range]);
  useEffect(() => {
    if (!enabled) return;
    const reconnect=()=>void load();window.addEventListener('online',reconnect);
    void load();
    const timer = setInterval(() => void load(), 8000);
    return () => { version.current++; clearInterval(timer);window.removeEventListener('online',reconnect); };
  }, [load, enabled]);
  return { range, setRange, reload: load, ...state };
}
export type UsageData = ReturnType<typeof useUsage>;
