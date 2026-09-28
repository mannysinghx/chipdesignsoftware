'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { LayoutManifest } from '@/lib/a1-layout-format';
import { CELL_CLASS_TEXT } from '@/lib/a1-layout-parts';
import { getUiAudit } from '@/lib/ui-audit';
import { useTrackedValue } from '@/lib/ui-audit-react';
import type { DragMode, Flows, LabelMode, LayoutEngine, LayoutHud, LayoutSelection, LayoutStopId } from './silicon/layout-engine';

// The Silicon macro view's "A1 layout" mode: the real routed A1 tensor tile
// (SKY130), drawn from its DEF and the SkyWater cell library, with the same
// controls as the illustrative model.

type FullscreenElement = HTMLDivElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type FullscreenDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
const currentFullscreenElement = () => {
  const owner = document as FullscreenDocument;
  return owner.fullscreenElement ?? owner.webkitFullscreenElement ?? null;
};

const compact = (value: number) => (value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}k` : String(Math.round(value)));
const megabytes = (bytes: number) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} kB`);

const LADDER: Array<{ id: LayoutStopId; label: string }> = [
  { id: 'tile', label: 'Tile' },
  { id: 'region', label: 'Region' },
  { id: 'routing', label: 'Routing' },
  { id: 'cells', label: 'Cells' },
  { id: 'devices', label: 'Transistors' },
];
const LABEL_MODES: Array<{ id: LabelMode; label: string; title: string }> = [
  { id: 'all', label: 'All', title: 'Label the register regions and each kind of wire, via, cell, and device in view' },
  { id: 'key', label: 'Key', title: 'Label only the main regions and parts' },
  { id: 'off', label: 'Off', title: 'Hide the labels (hover still names what is under the cursor)' },
];
const FLOW_TOGGLES: Array<{ id: keyof Flows; label: string; title: string; swatch: string }> = [
  { id: 'data', label: 'Data', title: 'Pulses run along each signal net, starting at the output pin of the cell that drives it (where that cell is loaded) and running out to the pins it drives', swatch: '#38dbff' },
  { id: 'power', label: 'Power', title: 'Show the supply: VDD (amber) down from the straps through the via stacks to the rails; VSS (green) back', swatch: '#ff8a1c' },
  { id: 'clock', label: 'Clock', title: 'Show the clock-tree nets from their buffers to the flip-flops', swatch: '#db5cff' },
];
const FLOW_WORDS: Record<NonNullable<LayoutSelection['net']>['kind'], string> = { signal: 'Signal net', clock: 'Clock net', vdd: 'VDD supply network', vss: 'VSS ground network' };
const FLOW_CLASS: Record<NonNullable<LayoutSelection['net']>['kind'], string> = { signal: 'flow-data', clock: 'flow-clock', vdd: 'flow-vdd', vss: 'flow-vss' };

type LegendItem = { title: string; layer: string; swatch: string; glow?: boolean };
const SW = { metal: '#a9abb2', plug: '#9aa1aa', local: '#8a7a6e', poly: '#9a7560', ndiff: '#6d84a6', pdiff: '#9a8062', well: '#2e3748' };
const cellItems = (): LegendItem[] => (['logic', 'sequential', 'clock', 'fill'] as const).map((cls) => ({ title: CELL_CLASS_TEXT[cls].title, layer: CELL_CLASS_TEXT[cls].role, swatch: CELL_CLASS_TEXT[cls].swatch }));
const LEGEND: Record<LayoutStopId, LegendItem[]> = {
  tile: [
    { title: 'Supply straps', layer: 'met5 (horizontal) and met4 (vertical), VDD and VSS', swatch: SW.metal },
    { title: 'Via 4 arrays', layer: 'where a met5 and a met4 strap of one supply cross', swatch: SW.plug },
    { title: 'Routing density', layer: 'met1–met4 coverage per 2.5 µm, brighter = denser', swatch: '#8d8c90' },
    { title: 'Registers', layer: 'flip-flop density (blue)', swatch: CELL_CLASS_TEXT.sequential.swatch },
    { title: 'Clock tree and buffers', layer: 'their density (violet)', swatch: CELL_CLASS_TEXT.clock.swatch },
    { title: 'I/O pins', layer: 'met2/met3, along the tile edges', swatch: SW.metal },
  ],
  region: [
    { title: 'Metal 1–4 wires', layer: 'routed signal nets', swatch: SW.metal, glow: true },
    { title: 'Vias', layer: 'via, via2, via3: where a route changes layer', swatch: SW.plug, glow: true },
    { title: 'Supply rails and straps', layer: 'met1 rails, met4/met5 straps', swatch: SW.metal },
    ...cellItems(),
  ],
  routing: [
    { title: 'Metal 1, 2, 3 wires', layer: 'horizontal, vertical, horizontal', swatch: SW.metal, glow: true },
    { title: 'Vias and mcon contacts', layer: 'layer changes and pin landings', swatch: SW.plug, glow: true },
    { title: 'Supply via stacks', layer: 'met4 strap down to a met1 rail', swatch: SW.plug },
    ...cellItems(),
  ],
  cells: [
    { title: 'Local interconnect (li1)', layer: 'wiring inside each cell, and its pins', swatch: SW.local },
    { title: 'mcon contacts', layer: 'li1 up to met1', swatch: SW.plug },
    { title: 'Metal 1', layer: 'routes and the supply rails', swatch: SW.metal, glow: true },
    { title: 'Diffusion and poly', layer: 'the transistors below', swatch: SW.poly },
  ],
  devices: [
    { title: 'N+ diffusion', layer: 'NMOS source and drain', swatch: SW.ndiff },
    { title: 'P+ diffusion', layer: 'PMOS source and drain, in the n-well', swatch: SW.pdiff },
    { title: 'Polysilicon', layer: 'gates: each crossing of diffusion is a transistor', swatch: SW.poly },
    { title: 'Contacts (licon)', layer: 'diffusion and poly up to li1', swatch: SW.plug },
    { title: 'N-well', layer: 'body of the PMOS transistors', swatch: SW.well },
  ],
};
const FLOW_KEY: Array<{ id: string; label: string; swatch: string; detail: string }> = [
  { id: 'data', label: 'Data', swatch: '#38dbff', detail: 'from the driving pin outward' },
  { id: 'vdd', label: 'VDD', swatch: '#ff8a1c', detail: 'supply, down the via stacks' },
  { id: 'vss', label: 'VSS', swatch: '#6cff4d', detail: 'ground return' },
  { id: 'clock', label: 'Clock', swatch: '#db5cff', detail: 'clock-tree nets' },
];

export default function SiliconLayoutView({ sourceSwitch }: { sourceSwitch: ReactNode }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<LayoutEngine | null>(null);
  const [manifest, setManifest] = useState<LayoutManifest | null>(null);
  const [hud, setHud] = useState<LayoutHud | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flows, setFlows] = useState<Flows>({ data: true, power: false, clock: false });
  const [netShown, setNetShown] = useState(true);
  const [bloom, setBloom] = useState(true);
  const [section, setSection] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  const [destination, setDestination] = useState<LayoutStopId>('tile');
  const [labelMode, setLabelMode] = useState<LabelMode>('all');
  const [dragMode, setDragMode] = useState<DragMode>('rotate');
  const [legendOpen, setLegendOpen] = useState(() => typeof window === 'undefined' || !window.matchMedia('(max-width: 720px)').matches);
  const [selection, setSelection] = useState<LayoutSelection | null>(null);

  useTrackedValue('ui.state', 'changed', 'silicon.layout.flows', Object.entries(flows).filter(([, on]) => on).map(([id]) => id).join(',') || 'none');
  useTrackedValue('ui.state', 'changed', 'silicon.layout.netShown', netShown);
  useTrackedValue('ui.state', 'changed', 'silicon.layout.bloom', bloom);
  useTrackedValue('ui.state', 'changed', 'silicon.layout.section', section);
  useTrackedValue('ui.state', 'changed', 'silicon.layout.autoRotate', autoRotate);
  useTrackedValue('ui.state', 'changed', 'silicon.layout.fullscreen', fullscreen);
  useTrackedValue('ui.state', 'changed', 'silicon.layout.destination', destination);
  useTrackedValue('ui.state', 'changed', 'silicon.layout.labels', labelMode);
  useTrackedValue('ui.state', 'changed', 'silicon.layout.dragMode', dragMode);
  useTrackedValue('ui.state', 'changed', 'silicon.layout.legend', legendOpen);
  useTrackedValue('ui.state', 'changed', 'silicon.layout.selection', selection ? `${selection.title} (${selection.layer})` : null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let engine: LayoutEngine | null = null;
    let cancelled = false;
    let frame = 0;
    let timer = 0;
    // As in the model view: the engine loads with the mode and starts in a task of
    // its own, after the loading state has painted.
    import('./silicon/layout-engine').then(({ createLayoutEngine }) => {
      if (cancelled) return;
      frame = window.requestAnimationFrame(() => {
        timer = window.setTimeout(() => {
          if (cancelled) return;
          try {
            engine = createLayoutEngine(host, {
              onManifest: setManifest,
              onHud: setHud,
              onReady: () => setReady(true),
              onError: setError,
              onCameraGesture: (details) => getUiAudit()?.interaction('camera', details, { type: 'control', id: 'A1 layout camera' }),
              onSelect: setSelection,
            });
            engineRef.current = engine;
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
          }
        }, 0);
      });
    }, (reason: unknown) => setError(`The 3D engine failed to load: ${reason instanceof Error ? reason.message : String(reason)}`));
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      engine?.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => { engineRef.current?.setFlows(flows); }, [flows, ready]);
  useEffect(() => { engineRef.current?.setNetShown(netShown); }, [netShown, ready]);
  useEffect(() => { engineRef.current?.setBloom(bloom); }, [bloom, ready]);
  useEffect(() => { engineRef.current?.setSection(section); }, [section, ready]);
  useEffect(() => { engineRef.current?.setAutoRotate(autoRotate); }, [autoRotate, ready]);
  useEffect(() => { engineRef.current?.setLabelMode(labelMode); }, [labelMode, ready]);
  useEffect(() => { engineRef.current?.setDragMode(dragMode); }, [dragMode, ready]);

  useEffect(() => {
    const shell = shellRef.current as FullscreenElement | null;
    setFullscreenSupported(Boolean(shell?.requestFullscreen ?? shell?.webkitRequestFullscreen));
    const sync = () => setFullscreen(currentFullscreenElement() === shellRef.current);
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    sync();
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
    };
  }, []);

  const toggleFullscreen = async () => {
    const shell = shellRef.current as FullscreenElement | null;
    if (!shell) return;
    const owner = document as FullscreenDocument;
    try {
      if (currentFullscreenElement()) await (owner.exitFullscreen ? owner.exitFullscreen() : owner.webkitExitFullscreen?.());
      else await (shell.requestFullscreen ? shell.requestFullscreen() : shell.webkitRequestFullscreen?.());
    } catch {
      setFullscreen(currentFullscreenElement() === shellRef.current);
    }
  };

  const fly = (id: LayoutStopId) => {
    setDestination(id);
    engineRef.current?.flyTo(id);
  };

  const stopId = hud?.stop.id ?? 'tile';
  const legend = LEGEND[stopId];
  const def = manifest?.sources.find((source) => source.role.startsWith('Routed layout'));
  const evidenceTitle = manifest ? `${manifest.evidence.statement}\n\n${manifest.evidence.drc}\n${manifest.evidence.lvs}\n${manifest.evidence.timing}` : 'Loading the layout';
  const caption = manifest
    ? `${manifest.title} · ${((manifest.die[2] - manifest.die[0]) / manifest.dbuPerMicron / 1000).toFixed(2)} mm square · ${(manifest.insts.count + manifest.insts.fill).toLocaleString()} placed cells · ${manifest.nets.count.toLocaleString()} nets`
    : 'AIMEM-A1 tensor tile · SkyWater SKY130';

  return (
    <section className={`silicon-shell${fullscreen ? ' fullscreen' : ''}`} ref={shellRef} data-audit-area="Silicon macro · A1 layout">
      <div
        className="silicon-canvas"
        ref={hostRef}
        role="application"
        tabIndex={0}
        aria-roledescription="3D chip layout viewer"
        aria-label="Interactive 3D view of the real AIMEM-A1 tensor tile layout on SkyWater SKY130: the routed wires, vias, and power grid from its DEF, and each standard cell's transistors, contacts, and wiring from the cell library, at true layer heights. Arrow keys move the view, plus and minus zoom, Escape clears the selection."
      />

      <div className="silicon-top">
        <div className="silicon-toolbar" role="toolbar" aria-label="A1 layout view controls">
          {sourceSwitch}
          <button onClick={() => fly('tile')} title="Fly back to the whole tile">Fit</button>
          <span className="silicon-segment silicon-flows" role="group" aria-label="Flows">
            <em>Flow</em>
            {FLOW_TOGGLES.map((flow) => (
              <button key={flow.id} className={flows[flow.id] ? 'active' : ''} aria-pressed={flows[flow.id]} onClick={() => setFlows((current) => ({ ...current, [flow.id]: !current[flow.id] }))} title={flow.title}>
                <i style={{ background: flow.swatch }} />{flow.label}
              </button>
            ))}
          </span>
          <button className={bloom && !hud?.software ? 'active' : ''} aria-pressed={bloom && !hud?.software} disabled={hud?.software} onClick={() => setBloom((value) => !value)} title={hud?.software ? 'Bloom is off on software rendering (no GPU acceleration)' : 'Bloom on the pulses'}>Bloom</button>
          <button className={section ? 'active' : ''} aria-pressed={section} onClick={() => setSection((value) => !value)} title="Cut a vertical section through the target to show the real SKY130 layer stack at true scale">Cross-section</button>
          <button className={autoRotate ? 'active' : ''} aria-pressed={autoRotate} onClick={() => setAutoRotate((value) => !value)} title="Spin the tile slowly on its own; drag any time to take over">Spin</button>
          <button className={dragMode === 'pan' ? 'active' : ''} aria-pressed={dragMode === 'pan'} onClick={() => setDragMode((mode) => (mode === 'pan' ? 'rotate' : 'pan'))} title={dragMode === 'pan' ? 'Dragging moves the view; right-drag rotates. Click to drag-rotate again' : 'Make a plain drag move the view instead of rotating it (right-drag or Shift-drag always moves it)'}>✥ Pan</button>
          <span className="silicon-segment" role="group" aria-label="Labels">
            <em>Labels</em>
            {LABEL_MODES.map((mode) => (
              <button key={mode.id} className={labelMode === mode.id ? 'active' : ''} aria-pressed={labelMode === mode.id} onClick={() => setLabelMode(mode.id)} title={mode.title}>{mode.label}</button>
            ))}
          </span>
          <button className={legendOpen ? 'active' : ''} aria-pressed={legendOpen} onClick={() => setLegendOpen((value) => !value)} title="What each colour and structure is at this zoom">Legend</button>
          {fullscreenSupported && <button className={fullscreen ? 'active' : ''} aria-pressed={fullscreen} onClick={toggleFullscreen} title={fullscreen ? 'Exit full screen (Esc)' : 'Open the view full screen'}>{fullscreen ? '⤡ Exit' : '⤢ Full screen'}</button>}
        </div>
        <nav className="silicon-ladder" aria-label="Zoom ladder: fly to a scale of the A1 tile">
          {LADDER.map((rung, index) => (
            <button key={rung.id} className={stopId === rung.id ? 'active' : ''} aria-pressed={stopId === rung.id} onClick={() => fly(rung.id)}>
              <i>{index + 1}</i>{rung.label}
            </button>
          ))}
        </nav>
      </div>

      {legendOpen && (
        <aside className="silicon-legend" data-silicon-occluder aria-label={`Legend: what the A1 layout shows at the ${hud?.stop.label ?? 'tile'} scale`}>
          <header>
            <span className="silicon-kicker">Legend · {hud?.stop.label ?? 'A1 tile'}</span>
            <button onClick={() => setLegendOpen(false)} aria-label="Close the legend">×</button>
          </header>
          <ul>
            {legend.map((item) => (
              <li key={item.title} title={item.layer}>
                <i className={item.glow ? 'glow' : ''} style={{ background: item.swatch }} />
                <span><b>{item.title}</b><small>{item.layer}</small></span>
              </li>
            ))}
          </ul>
          <div className="silicon-flow-key" aria-label="Pulse colours">
            {FLOW_KEY.map((item) => <span key={item.id} title={item.detail}><i style={{ background: item.swatch }} />{item.label}</span>)}
          </div>
          <p>Wires, vias, and the transistors of every cell are the real layout at true height; from afar, cell outlines and the density map summarize it. Pulses mark what a wire carries and which way the signal goes; their timing is not simulated.</p>
          {manifest && <p className="silicon-provenance">Run {manifest.run} · RTL {manifest.rtlCommit}{def ? ` · DEF ${def.sha256.slice(0, 12)}…` : ''}</p>}
        </aside>
      )}

      {selection && (
        <aside className="silicon-selection" data-silicon-occluder aria-label={`Selected: ${selection.title}`} aria-live="polite">
          <header>
            <span className="silicon-kicker">{selection.layer}</span>
            <button onClick={() => engineRef.current?.clearSelection()} aria-label="Clear the selected part">×</button>
          </header>
          <strong>{selection.cell?.name ?? selection.title}</strong>
          {selection.cell?.name && <p className="silicon-mono">{selection.title}</p>}
          <p>{selection.role}</p>
          {selection.net && (
            <section className="silicon-explain" aria-label="Net">
              <h4>Net</h4>
              <div className="silicon-net">
                <div className="silicon-net-head">
                  <b className={FLOW_CLASS[selection.net.kind]}>{FLOW_WORDS[selection.net.kind]}</b>
                  <span className="silicon-mono">{selection.net.name ?? '…'}</span>
                  {selection.net.pieces > 0 && <button className={netShown ? 'active' : ''} aria-pressed={netShown} onClick={() => setNetShown((value) => !value)} title="Outline every piece of this net, through the other layers">{netShown ? 'Hide net' : 'Show net'}</button>}
                </div>
                {selection.net.length !== null && <p className="silicon-net-pins">{selection.net.length.toLocaleString()} µm of wire · {selection.net.vias?.toLocaleString()} vias · {selection.net.layers.join(', ') || 'no routing'}{selection.net.pieces > 0 ? ` · ${selection.net.pieces.toLocaleString()} shapes outlined` : ''}</p>}
                {selection.net.note && <p className="silicon-net-open">{selection.net.note}</p>}
                {selection.net.pins === null && selection.net.kind !== 'vdd' && selection.net.kind !== 'vss' && !selection.net.note && <p className="silicon-net-pins">Finding the pins on the metal…</p>}
                {selection.net.pins && selection.net.pins.length > 0 && (
                  <ol className="silicon-net-layers" aria-label="Pins the net joins, driver first">
                    {selection.net.pins.slice(0, 12).map((pin, index) => (
                      <li key={`${pin.inst}-${pin.pin}-${index}`}>
                        <span>{pin.io ? `I/O ${pin.dir}` : pin.dir === 'output' ? 'drives' : 'input'}</span>
                        <em className="silicon-mono">{pin.io ? pin.pin : `${pin.inst ?? '…'} (${pin.cell}) ${pin.pin}`}</em>
                      </li>
                    ))}
                    {selection.net.pins.length > 12 && <li><span>…</span><em>{selection.net.pins.length - 12} more pins</em></li>}
                  </ol>
                )}
              </div>
            </section>
          )}
          {selection.cell && (
            <section className="silicon-explain" aria-label="Cell">
              <h4>Cell</h4>
              <p><b className="silicon-mono">{selection.cell.macro.replace('sky130_fd_sc_hd__', '')}</b>: {selection.cell.what}{selection.cell.drive ? `, ${selection.cell.drive}` : ''}. {CELL_CLASS_TEXT[selection.cell.cls].title}: {CELL_CLASS_TEXT[selection.cell.cls].role}.</p>
              <p className="silicon-net-pins">{selection.cell.size} · {selection.cell.place}{selection.cell.transistors > 0 ? ` · ${selection.cell.transistors} transistors` : ''}</p>
              {selection.cell.pins && selection.cell.pins.length > 0 && (
                <ol className="silicon-net-layers" aria-label="The cell's pins and their nets">
                  {selection.cell.pins.map((pin) => <li key={pin.pin}><span>{pin.pin} · {pin.dir}</span><em className="silicon-mono">{pin.net ?? 'not connected'}</em></li>)}
                </ol>
              )}
            </section>
          )}
          {selection.explain && (
            <>
              <section className="silicon-explain" aria-label="What it does">
                <h4>What it does</h4>
                <p>{selection.explain.does}</p>
              </section>
              <section className="silicon-explain" aria-label="Connections">
                <h4>Connections</h4>
                <p>{selection.explain.connects}</p>
              </section>
              <section className="silicon-explain" aria-label="How it is made">
                <h4>How it is made</h4>
                <ol>{selection.explain.made.map((step) => <li key={step}>{step}</li>)}</ol>
              </section>
            </>
          )}
          <dl>
            {selection.material && <><dt>Material</dt><dd>{selection.material}</dd></>}
            <dt>Size</dt><dd>{selection.size}</dd>
            <dt>Where</dt><dd>{selection.location.join(' › ')}</dd>
          </dl>
          {selection.notes.length > 0 && <ul>{selection.notes.map((note) => <li key={note}>{note}</li>)}</ul>}
          <button className="silicon-zoom-to" onClick={() => engineRef.current?.zoomToSelection()}>Zoom to it</button>
        </aside>
      )}

      <div className="silicon-hud" data-silicon-occluder>
        <div aria-live="polite">
          <span className="silicon-kicker">{hud ? hud.stop.label : 'A1 tile'}</span>
          <strong>{hud ? hud.stop.layer : 'The real routed layout'}</strong>
        </div>
        {hud?.view === 'underside' && <span className="silicon-underside">From below · the silicon is lifted away, transistors seen from their backside</span>}
        <p>{!hud || hud.stop.id === 'tile' ? caption : hud.location.join(' › ')}</p>
        {hud && (
          <div className="silicon-scale" aria-label={`Scale bar: ${hud.scale.label}`}>
            <i style={{ width: `${Math.round(hud.scale.px)}px` }} />
            <span>{hud.scale.label}</span>
          </div>
        )}
      </div>

      <div className="silicon-meta" data-silicon-occluder>
        <div className="silicon-perf" aria-label="Rendering performance">
          <b className={hud && hud.fps < 50 ? 'slow' : ''}>{hud ? `${hud.fps.toFixed(0)} fps` : '— fps'}</b>
          <span>{hud ? `${hud.frameMs.toFixed(1)} ms` : ''}</span>
          <span>{hud ? `${hud.drawCalls} draws` : ''}</span>
          <span>{hud ? `${compact(hud.triangles)} tris` : ''}</span>
          <span>{hud ? `${compact(hud.instances)} shapes · ${hud.chunks}${hud.pending ? ` +${hud.pending}` : ''} tiles` : ''}</span>
          <span>{hud ? `${megabytes(hud.bytes)} loaded` : ''}</span>
          <span>{hud ? `${hud.dpr.toFixed(2)}× res${hud.software ? ' · software GL' : ''}` : ''}</span>
        </div>
        <div className="silicon-evidence real" title={evidenceTitle}>
          <i />Real layout · SKY130 DEF + cell GDS · DRC 0 · LVS match, qualified
        </div>
      </div>

      <div className="silicon-help">{dragMode === 'pan' ? 'Drag to move the view · right-drag to rotate 360°' : 'Drag to rotate 360° · right-drag or Shift-drag to move the view'} · scroll or pinch to zoom at the cursor · click any wire or cell to see its net, pins, and how it is made · double-click to dive</div>

      {!ready && !error && <div className="silicon-status">Loading the A1 layout…</div>}
      {error && <div className="silicon-status error" role="alert">{error}</div>}
    </section>
  );
}
