'use client';

import { useEffect, useRef, useState } from 'react';
import { DIE, PHYS, PRESETS, SILICON_EVIDENCE, TILES } from '@/lib/silicon-macro';
import { EXPLAIN, explainRegion, type Explanation } from '@/lib/silicon-explain';
import { PARTS, legendFor, type PartId } from '@/lib/silicon-parts';
import { getUiAudit } from '@/lib/ui-audit';
import { useTrackedValue } from '@/lib/ui-audit-react';
import type { DragMode, Flows, LabelMode, SiliconEngine, SiliconHud, SiliconSelection } from './silicon/engine';

// Safari still ships only the prefixed Fullscreen API.
type FullscreenElement = HTMLDivElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type FullscreenDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
const currentFullscreenElement = () => {
  const owner = document as FullscreenDocument;
  return owner.fullscreenElement ?? owner.webkitFullscreenElement ?? null;
};

const compact = (value: number) => (value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}k` : String(Math.round(value)));
// The routing stop sits between the Tensor PE and Cells presets.
const ladderId = (stopId: string) => (stopId === 'routing' ? 'block' : stopId);
const DIE_CAPTION = `Accelerator die · ${DIE.width.toFixed(1)} × ${DIE.depth.toFixed(1)} mm · ${TILES.length} compute tiles · ${PHYS.length} memory PHYs`;
const LABEL_MODES: Array<{ id: LabelMode; label: string; title: string }> = [
  { id: 'all', label: 'All', title: 'Label the regions and every kind of wire, via, and device in view' },
  { id: 'key', label: 'Key', title: 'Label only the main regions and parts' },
  { id: 'off', label: 'Off', title: 'Hide the labels (hover still names what is under the cursor)' },
];
const FLOW_TOGGLES: Array<{ id: keyof Flows; label: string; title: string; swatch: string }> = [
  { id: 'data', label: 'Data', title: 'Pulses carry data along each net: out of a cell, up through the vias, along the wires, and down into the cells it drives', swatch: '#38dbff' },
  { id: 'power', label: 'Power', title: 'Show the supply flowing: VDD (amber) down from the bumps through the mesh, straps, and via ladders to the transistors; VSS (green) back', swatch: '#ff8a1c' },
  { id: 'clock', label: 'Clock', title: 'Show the clock fanning out from each local clock buffer to the flip-flops it drives (zoom to Cells to see the clock nets)', swatch: '#db5cff' },
];
const FLOW_KEY: Array<{ id: string; label: string; swatch: string; detail: string }> = [
  { id: 'data', label: 'Data', swatch: '#38dbff', detail: 'along each net, through its vias' },
  { id: 'vdd', label: 'VDD', swatch: '#ff8a1c', detail: 'supply, down from the bumps' },
  { id: 'vss', label: 'VSS', swatch: '#6cff4d', detail: 'ground return, back up' },
  { id: 'clock', label: 'Clock', swatch: '#db5cff', detail: 'buffer to flip-flops' },
];
const FLOW_WORDS: Record<NonNullable<SiliconSelection['net']>['flow'], string> = { data: 'Signal net', vdd: 'VDD supply network', vss: 'VSS ground network', clock: 'Clock net' };

function explanationFor(selection: SiliconSelection): Explanation | null {
  if (selection.kind === 'region') return explainRegion(selection.id, selection.title);
  return selection.id in PARTS ? EXPLAIN[selection.id as PartId] : null;
}

const VIEW_NOTE: Record<SiliconHud['view'], string | null> = {
  top: null,
  underside: 'Underside · BGA balls face the board',
  backside: 'Backside view · package hidden, looking up through the silicon',
};

export default function SiliconMacroView() {
  const hostRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<SiliconEngine | null>(null);
  const [hud, setHud] = useState<SiliconHud | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flows, setFlows] = useState<Flows>({ data: true, power: false, clock: false });
  const [netShown, setNetShown] = useState(true);
  const [bloom, setBloom] = useState(true);
  const [section, setSection] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  const [destination, setDestination] = useState('die');
  const [labelMode, setLabelMode] = useState<LabelMode>('all');
  const [dragMode, setDragMode] = useState<DragMode>('rotate');
  // Open by default except on phone-width screens, where it would cover a third of the view.
  const [legendOpen, setLegendOpen] = useState(() => typeof window === 'undefined' || !window.matchMedia('(max-width: 720px)').matches);
  const [selection, setSelection] = useState<SiliconSelection | null>(null);

  useTrackedValue('ui.state', 'changed', 'silicon.flows', Object.entries(flows).filter(([, on]) => on).map(([id]) => id).join(',') || 'none');
  useTrackedValue('ui.state', 'changed', 'silicon.netShown', netShown);
  useTrackedValue('ui.state', 'changed', 'silicon.bloom', bloom);
  useTrackedValue('ui.state', 'changed', 'silicon.section', section);
  useTrackedValue('ui.state', 'changed', 'silicon.autoRotate', autoRotate);
  useTrackedValue('ui.state', 'changed', 'silicon.fullscreen', fullscreen);
  useTrackedValue('ui.state', 'changed', 'silicon.destination', destination);
  useTrackedValue('ui.state', 'changed', 'silicon.labels', labelMode);
  useTrackedValue('ui.state', 'changed', 'silicon.dragMode', dragMode);
  useTrackedValue('ui.state', 'changed', 'silicon.legend', legendOpen);
  useTrackedValue('ui.state', 'changed', 'silicon.selection', selection ? `${selection.title} (${selection.layer})` : null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let engine: SiliconEngine | null = null;
    let cancelled = false;
    let frame = 0;
    let timer = 0;
    // three.js and the generators load with the view, not with the Studio.
    // The engine starts after the loading state has painted, in a task of its
    // own: a click that opens this view must finish before any GPU setup runs.
    import('./silicon/engine').then(({ createSiliconEngine }) => {
      if (cancelled) return;
      frame = window.requestAnimationFrame(() => {
        timer = window.setTimeout(() => {
          if (cancelled) return;
          try {
            engine = createSiliconEngine(host, {
              onHud: setHud,
              onReady: () => setReady(true),
              onError: setError,
              onCameraGesture: (details) => getUiAudit()?.interaction('camera', details, { type: 'control', id: 'Silicon macro camera' }),
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
      // A permissions policy can refuse full screen; the inline view still works.
      setFullscreen(currentFullscreenElement() === shellRef.current);
    }
  };

  const fly = (id: string) => {
    setDestination(id);
    engineRef.current?.flyTo(id);
  };

  const activeRung = hud ? ladderId(hud.stop.id) : 'die';
  const stopId = hud?.stop.id ?? 'die';
  const legend = legendFor(stopId);
  const explanation = selection ? explanationFor(selection) : null;
  const viewNote = hud ? VIEW_NOTE[hud.view] : null;

  return (
    <section className={`silicon-shell${fullscreen ? ' fullscreen' : ''}`} ref={shellRef} data-audit-area="Silicon macro">
      <div
        className="silicon-canvas"
        ref={hostRef}
        role="application"
        tabIndex={0}
        aria-roledescription="3D chip viewer"
        aria-label="Interactive macro view of the accelerator die: a procedurally generated metal stack, standard cells, transistors, TSVs, and deep-trench capacitors that you can zoom from the whole package down to single gates. Arrow keys move the view, plus and minus zoom, Escape clears the selection."
      />

      <div className="silicon-top">
        <div className="silicon-toolbar" role="toolbar" aria-label="Silicon macro view controls">
          <button onClick={() => fly('die')} title="Fly back to the whole die">Fit</button>
          <span className="silicon-segment silicon-flows" role="group" aria-label="Flows">
            <em>Flow</em>
            {FLOW_TOGGLES.map((flow) => (
              <button key={flow.id} className={flows[flow.id] ? 'active' : ''} aria-pressed={flows[flow.id]} onClick={() => setFlows((current) => ({ ...current, [flow.id]: !current[flow.id] }))} title={flow.title}>
                <i style={{ background: flow.swatch }} />{flow.label}
              </button>
            ))}
          </span>
          <button className={bloom && !hud?.software ? 'active' : ''} aria-pressed={bloom && !hud?.software} disabled={hud?.software} onClick={() => setBloom((value) => !value)} title={hud?.software ? 'Bloom is off on software rendering (no GPU acceleration)' : 'Bloom on the glowing pathways'}>Bloom</button>
          <button className={section ? 'active' : ''} aria-pressed={section} onClick={() => setSection((value) => !value)} title="Cut a vertical section through the target to show the layer stack and deep trenches">Cross-section</button>
          <button className={autoRotate ? 'active' : ''} aria-pressed={autoRotate} onClick={() => setAutoRotate((value) => !value)} title="Spin the chip slowly on its own; drag any time to take over">Spin</button>
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
        <nav className="silicon-ladder" aria-label="Zoom ladder: fly to a scale">
          {PRESETS.map((preset, index) => (
            <button key={preset.id} className={activeRung === preset.id ? 'active' : ''} aria-pressed={activeRung === preset.id} onClick={() => fly(preset.id)}>
              <i>{index + 1}</i>{preset.label}
            </button>
          ))}
        </nav>
      </div>

      {legendOpen && (
        <aside className="silicon-legend" data-silicon-occluder aria-label={`Legend: what the view shows at the ${hud?.stop.label ?? 'Die'} scale`}>
          <header>
            <span className="silicon-kicker">Legend · {hud?.stop.label ?? 'Die'}</span>
            <button onClick={() => setLegendOpen(false)} aria-label="Close the legend">×</button>
          </header>
          <ul>
            {legend.map((item) => (
              <li key={item.id} title={item.role}>
                <i className={item.glow ? 'glow' : ''} style={{ background: item.swatch }} />
                <span><b>{item.title}</b><small>{item.layer}</small></span>
              </li>
            ))}
          </ul>
          <div className="silicon-flow-key" aria-label="Pulse colours">
            {FLOW_KEY.map((item) => <span key={item.id} title={item.detail}><i style={{ background: item.swatch }} />{item.label}</span>)}
          </div>
          <p>Hover anything to name it; click it to see what it does, how it is made, and its whole net.</p>
        </aside>
      )}

      {selection && (
        <aside className="silicon-selection" data-silicon-occluder aria-label={`Selected: ${selection.title}`} aria-live="polite">
          <header>
            <span className="silicon-kicker">{selection.layer}</span>
            <button onClick={() => engineRef.current?.clearSelection()} aria-label="Clear the selected part">×</button>
          </header>
          <strong>{selection.title}</strong>
          <p>{selection.role}</p>
          {explanation && (
            <section className="silicon-explain" aria-label="What it does">
              <h4>What it does</h4>
              <p>{explanation.does}</p>
            </section>
          )}
          {(explanation || selection.net) && (
            <section className="silicon-explain" aria-label="Connections">
              <h4>Connections</h4>
              {explanation && <p>{explanation.connects}</p>}
              {selection.net && (
                <div className="silicon-net">
                  <div className="silicon-net-head">
                    <b className={`flow-${selection.net.flow}`}>{FLOW_WORDS[selection.net.flow]}</b>
                    <span>{selection.net.truncated ? `${selection.net.pieces.toLocaleString()}+ pieces in view` : `${selection.net.pieces.toLocaleString()} connected piece${selection.net.pieces === 1 ? '' : 's'}`}</span>
                    <button className={netShown ? 'active' : ''} aria-pressed={netShown} onClick={() => setNetShown((value) => !value)} title="Outline every piece of this net, through the other layers">{netShown ? 'Hide net' : 'Show net'}</button>
                  </div>
                  {selection.net.open && !selection.net.truncated && <p className="silicon-net-open">The net runs on beyond the area loaded at this zoom: zoom out or move along it to follow the rest.</p>}
                  {selection.net.pins.length > 0 && <p className="silicon-net-pins">{selection.net.pins.slice(0, 6).join(' → ')}{selection.net.pins.length > 6 ? ` +${selection.net.pins.length - 6} more` : ''}{selection.net.gates > 0 ? ` · switches ${selection.net.gates} gate${selection.net.gates === 1 ? '' : 's'}` : ''}</p>}
                  <ol className="silicon-net-layers" aria-label="Layers the net passes through, top to bottom">
                    {[...selection.net.layers].reverse().map((layer) => <li key={layer.layer}><span>{layer.layer}</span><em>{layer.parts.slice(0, 3).join(', ')}{layer.count > 1 ? ` ×${layer.count}` : ''}</em></li>)}
                  </ol>
                </div>
              )}
            </section>
          )}
          {explanation && (
            <section className="silicon-explain" aria-label="How it is made">
              <h4>How it is made</h4>
              <ol>{explanation.made.map((step) => <li key={step}>{step}</li>)}</ol>
            </section>
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
        {/* Announced only when the scale stop changes, not on every zoom tick. */}
        <div aria-live="polite">
          <span className="silicon-kicker">{hud ? hud.stop.label : 'Die'}</span>
          <strong>{hud ? hud.stop.layer : 'Global power mesh, seal ring, and I/O pads'}</strong>
        </div>
        {viewNote && <span className="silicon-underside">{viewNote}</span>}
        <p>{!hud || hud.stop.id === 'package' || hud.stop.id === 'die' ? DIE_CAPTION : hud.location.join(' › ')}</p>
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
          <span>{hud ? `${compact(hud.instances)} parts · ${hud.chunks}${hud.pending ? ` +${hud.pending}` : ''} chunks` : ''}</span>
          <span>{hud ? `${hud.dpr.toFixed(2)}× res${hud.software ? ' · software GL' : ''}` : ''}</span>
        </div>
        <div className="silicon-evidence" title={SILICON_EVIDENCE.statement}>
          <i />Illustrative · procedural geometry, not GDS
        </div>
      </div>

      <div className="silicon-help">{dragMode === 'pan' ? 'Drag to move the view · right-drag to rotate 360°' : 'Drag to rotate 360°, over the top and underneath · right-drag or Shift-drag to move the view'} · scroll or pinch to zoom at the cursor · click any part to trace its net and see how it is made · double-click to dive</div>

      {!ready && !error && <div className="silicon-status">Growing the silicon…</div>}
      {error && <div className="silicon-status error" role="alert">{error}</div>}
    </section>
  );
}
