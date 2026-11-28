import { useState } from 'react';
import { CONNECTOR_LABELS, newId, type ConnectorType, type Group, type Light, type RestState } from '@uelights/shared';
import { api } from '../api';
import { useData } from '../data';
import { Dialog, Field, Icon, NumberInput, Switch, TopBar, confirmDelete } from '../ui';

const CONNECTOR_ICONS: Record<ConnectorType, string> = {
  twinkly: 'light_group',
  govee: 'wb_iridescent',
  amaran: 'highlight',
  hue: 'emoji_objects',
  homeassistant: 'home',
  virtual: 'view_week',
  webhook: 'webhook',
};

type Tab = ConnectorType | 'all' | 'groups';

export function LightsPage() {
  const { lights, groups } = useData();
  const [tab, setTab] = useState<Tab>('all');
  const [editing, setEditing] = useState<Light | null>(null);
  const [editingGroup, setEditingGroup] = useState<Group | null>(null);
  const connectors = Object.keys(CONNECTOR_LABELS) as ConnectorType[];
  const shown = lights.filter((l) => tab === 'all' || l.connector === tab);

  return (
    <>
      <TopBar title="Lichter" />
      <div className="page">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'all'} className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>
            Alle <span className="mono small">{lights.length}</span>
          </button>
          {connectors.map((c) => (
            <button key={c} role="tab" aria-selected={tab === c} className={tab === c ? 'on' : ''} onClick={() => setTab(c)}>
              <Icon name={CONNECTOR_ICONS[c]} style={{ fontSize: 18 }} />
              {CONNECTOR_LABELS[c]}
            </button>
          ))}
          <button role="tab" aria-selected={tab === 'groups'} className={tab === 'groups' ? 'on' : ''} onClick={() => setTab('groups')}>
            <Icon name="workspaces" style={{ fontSize: 18 }} />
            Gruppen <span className="mono small">{groups.length}</span>
          </button>
        </div>

        {tab === 'groups' ? (
          <Groups onEdit={setEditingGroup} />
        ) : (
          <>
            {shown.length === 0 && (
              <div className="empty">
                <Icon name="lightbulb" style={{ fontSize: 40, color: 'var(--primary)' }} />
                <span>Noch keine Lichter{tab !== 'all' ? ` vom Typ ${CONNECTOR_LABELS[tab as ConnectorType]}` : ''}. Tipp: Ein virtuelles Licht hilft beim Testen ohne Hardware.</span>
              </div>
            )}
            <div className="grid-3">
              {shown.map((l) => (
                <LightCard key={l.id} light={l} onEdit={() => setEditing(structuredClone(l))} />
              ))}
            </div>
          </>
        )}
      </div>
      {tab === 'groups' ? (
        <button className="fab" onClick={() => setEditingGroup({ id: '', name: 'Neue Gruppe', lightIds: [] })}>
          <Icon name="add" />
          Neue Gruppe
        </button>
      ) : (
        <button className="fab" onClick={() => setEditing(blankLight(tab === 'all' ? 'twinkly' : (tab as ConnectorType)))}>
          <Icon name="add" />
          Licht hinzufügen
        </button>
      )}
      {editing && <LightEditor light={editing} onClose={() => setEditing(null)} />}
      {editingGroup && <GroupEditor group={editingGroup} onClose={() => setEditingGroup(null)} />}
    </>
  );
}

function blankLight(connector: ConnectorType): Light {
  return {
    id: '',
    name: `${CONNECTOR_LABELS[connector]}-Licht`,
    connector,
    config: connector === 'virtual' ? { ledCount: 60 } : {},
    role: 'deco',
    restState: { mode: 'snapshot' },
    nativeEffects: [],
    enabled: true,
  };
}

function LightCard({ light, onEdit }: { light: Light; onEdit: () => void }) {
  const { save, remove, run, setLightLocal } = useData();
  const [probe, setProbe] = useState<{ ok: boolean; detail?: string } | null>(null);
  const address = (light.connector === 'hue' ? (light.config.hueType === 'grouped_light' ? 'Raum/Zone' : 'Lampe') : undefined) ?? light.config.host ?? light.config.ip ?? light.config.entityId ?? light.config.nodeId ?? light.config.url ?? (light.connector === 'virtual' ? `${light.config.ledCount ?? 60} LEDs` : '');
  return (
    <div className={`card ${light.enabled ? '' : 'off'}`} style={{ gap: 12, opacity: light.enabled ? 1 : 0.6 }}>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <span className={`avatar ${light.role === 'scene' ? 'grey' : 'cyan'}`}>
          <Icon name={CONNECTOR_ICONS[light.connector]} />
        </span>
        <div className="grow" style={{ display: 'flex', flexDirection: 'column' }}>
          <h3 style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{light.name}</h3>
          <span className="mono small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {CONNECTOR_LABELS[light.connector]} · {address}
          </span>
        </div>
        <label className="switch">
          <input type="checkbox" role="switch" checked={light.enabled} onChange={(e) => run(() => save('lights', { ...light, enabled: e.target.checked }))} />
          <span className="sr-only">Aktiv</span>
        </label>
      </div>
      <div className="row" style={{ gap: 6 }}>
        {light.role === 'scene' ? (
          <span className="tag" style={{ color: 'var(--error)' }}>
            <Icon name="lock" style={{ fontSize: 14 }} />
            Bildlicht
          </span>
        ) : (
          <span className="tag">Deko</span>
        )}
        <span className="tag">Ruhe: {restLabel(light.restState, light)}</span>
        {light.ledCount && <span className="tag">{light.ledCount} LEDs</span>}
        <span className="tag">{light.nativeEffects.length} Hersteller-Effekte</span>
      </div>
      {probe && (
        <span className={`chip ${probe.ok ? 'ok' : 'err'}`} style={{ height: 'auto', padding: '6px 10px', whiteSpace: 'normal' }}>
          <Icon name={probe.ok ? 'check_circle' : 'error'} />
          {probe.detail}
        </span>
      )}
      <div className="row" style={{ gap: 4 }}>
        <button
          className="btn text"
          onClick={async () => {
            const r = await run(() => api.post<{ ok: boolean; detail?: string; ledCount?: number }>(`/api/lights/${light.id}/probe`));
            if (r) {
              setProbe(r);
              if (r.ledCount) setLightLocal({ ...light, ledCount: r.ledCount });
            }
          }}
        >
          <Icon name="network_check" />
          Prüfen
        </button>
        <button className="btn text" onClick={() => run(() => api.post(`/api/lights/${light.id}/identify`), 'Licht blinkt 3 s')}>
          <Icon name="flare" />
          Finden
        </button>
        <span className="grow" />
        <button className="icon-btn" aria-label="Bearbeiten" onClick={onEdit}>
          <Icon name="edit" />
        </button>
        <button className="icon-btn" aria-label="Löschen" onClick={() => confirmDelete(light.name) && run(() => remove('lights', light.id), 'Licht gelöscht')}>
          <Icon name="delete" />
        </button>
      </div>
    </div>
  );
}

function restLabel(r: RestState, l: Light): string {
  if (r.mode === 'snapshot') return 'wie vorher';
  if (r.mode === 'off') return 'aus';
  if (r.mode === 'color') return `${r.color} ${r.brightness} %`;
  const nativeId = r.nativeId;
  return l.nativeEffects.find((n) => n.id === nativeId)?.name ?? 'Effekt';
}

interface Found {
  label: string;
  detail?: string;
  apply: Partial<Light['config']> & { name?: string };
}

function LightEditor({ light, onClose }: { light: Light; onClose: () => void }) {
  const { save, run, settings } = useData();
  const [l, setL] = useState<Light>(light);
  const [found, setFound] = useState<Found[] | null>(null);
  const [searching, setSearching] = useState(false);
  const set = (p: Partial<Light>) => setL((x) => ({ ...x, ...p }));
  const setCfg = (p: Partial<Light['config']>) => setL((x) => ({ ...x, config: { ...x.config, ...p } }));
  const isNew = !light.id;

  const discover = async () => {
    setSearching(true);
    setFound(null);
    try {
      if (l.connector === 'twinkly') {
        const r = await api.get<Array<{ ip: string; name: string; detail?: string }>>('/api/discover/twinkly');
        setFound(r.map((d) => ({ label: d.name, detail: d.detail ? `${d.ip} · ${d.detail}` : d.ip, apply: { host: d.ip, name: d.name } })));
      } else if (l.connector === 'govee') {
        const r = await api.get<Array<{ ip: string; sku: string; device: string }>>('/api/discover/govee');
        setFound(r.map((d) => ({ label: `${d.sku} ${d.device.slice(-5)}`, detail: d.ip, apply: { ip: d.ip, sku: d.sku, name: `Govee ${d.sku}` } })));
      } else if (l.connector === 'homeassistant') {
        const r = await api.get<Array<{ entityId: string; name: string; effects: number }>>('/api/discover/homeassistant');
        setFound(r.map((d) => ({ label: d.name, detail: `${d.entityId}${d.effects ? ` · ${d.effects} Effekte` : ''}`, apply: { entityId: d.entityId, name: d.name } })));
      } else if (l.connector === 'hue') {
        const r = await api.get<Array<{ id: string; type: 'light' | 'grouped_light'; name: string; kind: string; color: boolean }>>('/api/discover/hue');
        setFound(
          r.map((d) => ({
            label: d.name,
            detail: `${d.kind}${d.type === 'light' && !d.color ? ' · nur Weiß' : ''}`,
            apply: { hueId: d.id, hueType: d.type, name: d.name },
          })),
        );
      } else if (l.connector === 'amaran') {
        const r = await api.get<Array<{ nodeId: string; name: string }>>('/api/discover/amaran');
        setFound(r.map((d) => ({ label: d.name, detail: d.nodeId, apply: { nodeId: d.nodeId, deviceName: d.name, name: d.name } })));
      }
    } catch (err) {
      run(() => Promise.reject(err));
    } finally {
      setSearching(false);
    }
  };

  const canDiscover = ['twinkly', 'govee', 'hue', 'homeassistant', 'amaran'].includes(l.connector);
  const hint: Partial<Record<ConnectorType, string>> = {
    twinkly: 'Lokale xled-API (HTTP + UDP 7777). Feste IP im Router reservieren.',
    govee: '„LAN Control“ in der Govee-Home-App für das Gerät einschalten. UDP 4001–4003 im Netz erlauben.',
    hue: 'Über die Hue Bridge im lokalen Netz. Erst unter Einstellungen → Philips Hue koppeln, dann hier Lampe, Raum oder Zone suchen.',
    amaran: `Über die amaran-Desktop-App (${settings.amaran.url}). In den Einstellungen aktivieren.`,
    homeassistant: `Über Home Assistant (${settings.homeassistant.url}). In den Einstellungen aktivieren.`,
    virtual: 'Zeigt Effekte nur in der Web-App (Live-Seite) – zum Testen ohne Hardware.',
    webhook: 'Schickt bei jedem Alert ein HTTP POST mit JSON an diese Adresse im lokalen Netz.',
  };

  return (
    <Dialog
      title={isNew ? 'Licht hinzufügen' : l.name}
      onClose={onClose}
      wide
      actions={
        <>
          <button className="btn text" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="btn"
            onClick={async () => {
              const saved = await run(() => save('lights', l), 'Licht gespeichert');
              if (saved) onClose();
            }}
          >
            Speichern
          </button>
        </>
      }
    >
      <div className="grid-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        <Field label="Typ">
          <select value={l.connector} disabled={!isNew} onChange={(e) => set({ connector: e.target.value as ConnectorType, config: {} })}>
            {(Object.keys(CONNECTOR_LABELS) as ConnectorType[]).map((c) => (
              <option key={c} value={c}>
                {CONNECTOR_LABELS[c]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Name">
          <input value={l.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        {hint[l.connector]}
      </p>

      {canDiscover && (
        <div className="card" style={{ background: 'var(--surface)', gap: 8 }}>
          <div className="row">
            <span className="grow label">Im Netz suchen</span>
            <button className="btn tonal" onClick={discover} disabled={searching}>
              <Icon name={searching ? 'hourglass_top' : 'radar'} />
              {searching ? 'Suche …' : 'Suchen'}
            </button>
          </div>
          {found && found.length === 0 && <span className="small muted">Nichts gefunden. Adresse unten von Hand eintragen.</span>}
          {found && found.length > 0 && (
            <div className="list" style={{ gap: 4, maxHeight: 220, overflow: 'auto' }}>
              {found.map((f) => (
                <button
                  key={f.label + f.detail}
                  className="chip"
                  style={{ justifyContent: 'flex-start', height: 'auto', padding: '8px 12px' }}
                  onClick={() => {
                    const { name, ...cfg } = f.apply;
                    setL((x) => ({ ...x, name: x.name.endsWith('-Licht') && name ? name : x.name, config: { ...x.config, ...cfg } }));
                  }}
                >
                  <Icon name="add_circle" />
                  <span>{f.label}</span>
                  <span className="mono small muted">{f.detail}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="grid-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        {l.connector === 'twinkly' && (
          <>
            <Field label="IP-Adresse">
              <input value={l.config.host ?? ''} onChange={(e) => setCfg({ host: e.target.value.trim() })} placeholder="192.168.178.50" />
            </Field>
            <Field label="Farbkanäle (Echtzeit)" hint="Nur ändern, wenn Farben im Test vertauscht sind.">
              <select value={l.config.channelOrder ?? ''} onChange={(e) => setCfg({ channelOrder: (e.target.value || undefined) as Light['config']['channelOrder'] })}>
                <option value="">automatisch (vom Gerät)</option>
                <option value="RGB">RGB</option>
                <option value="GRB">GRB</option>
                <option value="WRGB">WRGB</option>
                <option value="RGBW">RGBW</option>
              </select>
            </Field>
          </>
        )}
        {l.connector === 'govee' && (
          <>
            <Field label="IP-Adresse">
              <input value={l.config.ip ?? ''} onChange={(e) => setCfg({ ip: e.target.value.trim() })} placeholder="192.168.178.60" />
            </Field>
            <Field label="Modell (SKU)">
              <input value={l.config.sku ?? ''} onChange={(e) => setCfg({ sku: e.target.value.trim() })} placeholder="H6076" />
            </Field>
          </>
        )}
        {l.connector === 'hue' && (
          <Field label="Hue-Ressource" hint={l.config.hueId ? `${l.config.hueType === 'grouped_light' ? 'Raum/Zone' : 'Lampe'} gewählt` : 'Oben „Suchen“ und Lampe, Raum oder Zone wählen'}>
            <input value={l.config.hueId ?? ''} readOnly className="mono" />
          </Field>
        )}
        {l.connector === 'amaran' && (
          <>
            <Field label="Node-ID">
              <input value={l.config.nodeId ?? ''} onChange={(e) => setCfg({ nodeId: e.target.value.trim() })} />
            </Field>
            <Field label="Farbfähigkeit" hint="Bi-Color-Leuchten (z. B. Halo 60x, Verge) können nur Weiß: Farben werden zu warm- oder kaltweiß.">
              <select value={l.config.amaranColor ?? 'auto'} onChange={(e) => setCfg({ amaranColor: e.target.value as 'auto' | 'rgb' | 'cct' })}>
                <option value="auto">automatisch erkennen</option>
                <option value="rgb">Vollfarbe (RGB)</option>
                <option value="cct">nur Weiß (Bi-Color)</option>
              </select>
            </Field>
          </>
        )}
        {l.connector === 'homeassistant' && (
          <Field label="Entität" hint="light.*, scene.* oder script.*">
            <input value={l.config.entityId ?? ''} onChange={(e) => setCfg({ entityId: e.target.value.trim() })} placeholder="light.govee_regal" />
          </Field>
        )}
        {l.connector === 'virtual' && (
          <Field label="Anzahl LEDs">
            <NumberInput value={l.config.ledCount ?? 60} min={1} max={600} onChange={(v) => setCfg({ ledCount: Math.round(v) })} />
          </Field>
        )}
        {l.connector === 'webhook' && (
          <Field label="URL">
            <input value={l.config.url ?? ''} onChange={(e) => setCfg({ url: e.target.value.trim() })} placeholder="http://192.168.178.10:1880/alert" />
          </Field>
        )}
      </div>

      <div className="grid-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        <Field label="Rolle" hint="Bildlichter (Key/Fill im Bild) werden von Alerts nie geschaltet, solange die Sperre aktiv ist.">
          <select value={l.role} onChange={(e) => set({ role: e.target.value as Light['role'] })}>
            <option value="deco">Deko – darf von Alerts gesteuert werden</option>
            <option value="scene">Bildlicht – für Alerts gesperrt</option>
          </select>
        </Field>
        <Field label="Ruhezustand nach einem Alert">
          <select
            value={l.restState.mode}
            onChange={(e) => {
              const m = e.target.value as RestState['mode'];
              if (m === 'snapshot' || m === 'off') set({ restState: { mode: m } });
              if (m === 'color') set({ restState: { mode: 'color', color: '#b794ff', brightness: 40 } });
              if (m === 'native') set({ restState: { mode: 'native', nativeId: l.nativeEffects[0]?.id ?? '' } });
            }}
          >
            <option value="snapshot">Wie vor dem Alert</option>
            <option value="off">Aus</option>
            <option value="color">Feste Farbe</option>
            <option value="native" disabled={l.nativeEffects.length === 0}>
              Hersteller-Effekt
            </option>
          </select>
        </Field>
      </div>
      {l.restState.mode === 'color' && (
        <div className="row">
          <Field label="Farbe" compact>
            <input type="color" value={l.restState.color} onChange={(e) => set({ restState: { ...(l.restState as { mode: 'color'; color: string; brightness: number }), color: e.target.value } })} />
          </Field>
          <Field label="Helligkeit %" compact>
            <NumberInput
              value={l.restState.brightness}
              min={1}
              max={100}
              onChange={(v) => set({ restState: { ...(l.restState as { mode: 'color'; color: string; brightness: number }), brightness: v } })}
            />
          </Field>
        </div>
      )}
      {l.restState.mode === 'native' && (
        <Field label="Effekt im Ruhezustand">
          <select value={l.restState.nativeId} onChange={(e) => set({ restState: { mode: 'native', nativeId: e.target.value } })}>
            {l.nativeEffects.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Switch checked={l.enabled} onChange={(v) => set({ enabled: v })} label="Licht aktiv" />
    </Dialog>
  );
}

function Groups({ onEdit }: { onEdit: (g: Group) => void }) {
  const { groups, lights, remove, run } = useData();
  if (groups.length === 0)
    return (
      <div className="empty">
        <Icon name="workspaces" style={{ fontSize: 40, color: 'var(--primary)' }} />
        Gruppen fassen Lichter verschiedener Hersteller zusammen, z. B. „Hintergrund“ = Twinkly + 2 Govee.
      </div>
    );
  return (
    <div className="grid-3">
      {groups.map((g) => (
        <div key={g.id} className="card" style={{ gap: 12 }}>
          <div className="row">
            <h3 className="grow">{g.name}</h3>
            <button className="icon-btn" aria-label="Bearbeiten" onClick={() => onEdit(structuredClone(g))}>
              <Icon name="edit" />
            </button>
            <button className="icon-btn" aria-label="Löschen" onClick={() => confirmDelete(g.name) && run(() => remove('groups', g.id), 'Gruppe gelöscht')}>
              <Icon name="delete" />
            </button>
          </div>
          <div className="row" style={{ gap: 6 }}>
            {g.lightIds.map((id) => {
              const l = lights.find((x) => x.id === id);
              return l ? (
                <span key={id} className="tag">
                  {l.name}
                </span>
              ) : null;
            })}
            {g.lightIds.length === 0 && <span className="small muted">leer</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function GroupEditor({ group, onClose }: { group: Group; onClose: () => void }) {
  const { lights, save, run } = useData();
  const [g, setG] = useState<Group>(group.id ? group : { ...group, id: newId('grp') });
  const toggle = (id: string) => setG((x) => ({ ...x, lightIds: x.lightIds.includes(id) ? x.lightIds.filter((i) => i !== id) : [...x.lightIds, id] }));
  return (
    <Dialog
      title={group.id ? g.name : 'Neue Gruppe'}
      onClose={onClose}
      actions={
        <>
          <button className="btn text" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="btn"
            onClick={async () => {
              const ok = await run(() => save('groups', g), 'Gruppe gespeichert');
              if (ok) onClose();
            }}
          >
            Speichern
          </button>
        </>
      }
    >
      <Field label="Name">
        <input value={g.name} onChange={(e) => setG({ ...g, name: e.target.value })} />
      </Field>
      <div className="list" style={{ gap: 4 }}>
        {lights.map((l) => (
          <label key={l.id} className="row" style={{ padding: '8px 4px', cursor: 'pointer', flexWrap: 'nowrap' }}>
            <input type="checkbox" checked={g.lightIds.includes(l.id)} onChange={() => toggle(l.id)} style={{ width: 20, height: 20, accentColor: 'var(--primary)' }} />
            <Icon name={CONNECTOR_ICONS[l.connector]} style={{ color: 'var(--on-surface-variant)' }} />
            <span className="grow">{l.name}</span>
            {l.role === 'scene' && <span className="tag">Bildlicht</span>}
          </label>
        ))}
      </div>
    </Dialog>
  );
}
