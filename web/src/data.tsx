import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Alert, Effect, EventLogEntry, Group, Light, LiveMessage, LiveState, Settings } from '@uelights/shared';
import { api } from './api';

export type PublicSettings = Settings & {
  meta: {
    jwtFromEnv: boolean;
    haTokenFromEnv: boolean;
    amaranKeyFromEnv?: boolean;
    passwordFromEnv: boolean;
    detectedChannelId: string | null;
    twitchLogin?: { userCode: string; verificationUri: string; expiresAt: number } | null;
    twitchError?: string | null;
  };
};

interface Bootstrap {
  alerts: Alert[];
  effects: Effect[];
  lights: Light[];
  groups: Group[];
  settings: PublicSettings;
  log: EventLogEntry[];
  live: LiveState;
}

export interface Toast {
  id: number;
  level: 'info' | 'error';
  text: string;
}

type Kind = 'alerts' | 'effects' | 'lights' | 'groups';
type ItemOf<K extends Kind> = K extends 'alerts' ? Alert : K extends 'effects' ? Effect : K extends 'lights' ? Light : Group;

interface DataCtx extends Bootstrap {
  loaded: boolean;
  online: boolean;
  virtualFrames: Record<string, string[]>;
  toasts: Toast[];
  notify: (text: string, level?: 'info' | 'error') => void;
  reload: () => Promise<void>;
  save: <K extends Kind>(kind: K, item: ItemOf<K>) => Promise<ItemOf<K>>;
  remove: (kind: Kind, id: string) => Promise<void>;
  reorder: <K extends Kind>(kind: K, items: ItemOf<K>[]) => Promise<void>;
  saveSettings: (s: Settings) => Promise<void>;
  setLightLocal: (l: Light) => void;
  run: <T>(fn: () => Promise<T>, success?: string) => Promise<T | undefined>;
}

const Ctx = createContext<DataCtx | null>(null);

export function useData(): DataCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('DataProvider fehlt');
  return c;
}

export function DataProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [online, setOnline] = useState(false);
  const [virtualFrames, setVirtualFrames] = useState<Record<string, string[]>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  const notify = useCallback((text: string, level: 'info' | 'error' = 'info') => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-2), { id, level, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), level === 'error' ? 6000 : 3500);
  }, []);

  const reload = useCallback(async () => {
    const b = await api.get<Bootstrap>('/api/bootstrap');
    setData(b);
  }, []);

  useEffect(() => {
    reload().catch(() => undefined);
  }, [reload]);

  // Live-Verbindung mit automatischem Neuverbinden
  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: number | undefined;
    let closed = false;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/api/live`);
      ws.onopen = () => setOnline(true);
      ws.onclose = () => {
        setOnline(false);
        if (!closed) timer = window.setTimeout(connect, 2000);
      };
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data) as LiveMessage;
        if (msg.type === 'state')
          setData((d) =>
            d
              ? {
                  ...d,
                  live: msg.state,
                  settings: { ...d.settings, triggerMode: msg.state.triggerMode, safety: { ...d.settings.safety, paused: msg.state.paused } },
                }
              : d,
          );
        else if (msg.type === 'event') setData((d) => (d ? { ...d, log: [msg.entry, ...d.log].slice(0, 200) } : d));
        else if (msg.type === 'eventUpdate')
          setData((d) =>
            d ? { ...d, log: d.log.map((e) => (e.event.id === msg.eventId ? { ...e, outcome: msg.outcome } : e)) } : d,
          );
        else if (msg.type === 'virtualFrame') setVirtualFrames((v) => ({ ...v, [msg.lightId]: msg.leds }));
        else if (msg.type === 'toast') notify(msg.text, msg.level);
      };
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [notify]);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>, success?: string) => {
      try {
        const r = await fn();
        if (success) notify(success);
        return r;
      } catch (err) {
        notify((err as Error).message, 'error');
        return undefined;
      }
    },
    [notify],
  );

  const save = useCallback(async <K extends Kind>(kind: K, item: ItemOf<K>) => {
    const exists = !!item.id && (data?.[kind] as Array<{ id: string }> | undefined)?.some((x) => x.id === item.id);
    const saved = exists
      ? await api.put<ItemOf<K>>(`/api/${kind}/${item.id}`, item)
      : await api.post<ItemOf<K>>(`/api/${kind}`, item);
    setData((d) => {
      if (!d) return d;
      const list = d[kind] as Array<{ id: string }>;
      const next = list.some((x) => x.id === saved.id) ? list.map((x) => (x.id === saved.id ? saved : x)) : [...list, saved];
      return { ...d, [kind]: next };
    });
    return saved;
  }, [data]);

  const remove = useCallback(async (kind: Kind, id: string) => {
    await api.del(`/api/${kind}/${id}`);
    setData((d) => (d ? { ...d, [kind]: (d[kind] as Array<{ id: string }>).filter((x) => x.id !== id) } : d));
    if (kind === 'lights') await reload();
  }, [reload]);

  const reorder = useCallback(async <K extends Kind>(kind: K, items: ItemOf<K>[]) => {
    setData((d) => (d ? { ...d, [kind]: items } : d));
    await api.put(`/api/${kind}`, items);
  }, []);

  const saveSettings = useCallback(async (s: Settings) => {
    const next = await api.put<PublicSettings>('/api/settings', s);
    setData((d) => (d ? { ...d, settings: next } : d));
  }, []);

  const setLightLocal = useCallback((l: Light) => {
    setData((d) => (d ? { ...d, lights: d.lights.map((x) => (x.id === l.id ? l : x)) } : d));
  }, []);

  const value = useMemo<DataCtx | null>(
    () =>
      data
        ? { ...data, loaded: true, online, virtualFrames, toasts, notify, reload, save, remove, reorder, saveSettings, setLightLocal, run }
        : null,
    [data, online, virtualFrames, toasts, notify, reload, save, remove, reorder, saveSettings, setLightLocal, run],
  );

  if (!value) {
    return (
      <div className="empty" style={{ margin: 48 }}>
        <span className="ms">hourglass_top</span>Lade ueLights …
      </div>
    );
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
