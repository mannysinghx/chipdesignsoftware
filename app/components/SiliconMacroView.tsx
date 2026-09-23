'use client';

import { useEffect, useRef, useState } from 'react';
import { DIE, PHYS, PRESETS, SILICON_EVIDENCE, TILES } from '@/lib/silicon-macro';
import { getUiAudit } from '@/lib/ui-audit';
import { useTrackedValue } from '@/lib/ui-audit-react';
import type { SiliconEngine, SiliconHud } from './silicon/engine';

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

export default function SiliconMacroView() {
  const hostRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<SiliconEngine | null>(null);
  const [hud, setHud] = useState<SiliconHud | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [glow, setGlow] = useState(true);
  const [bloom, setBloom] = useState(true);
  const [section, setSection] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  const [destination, setDestination] = useState('die');

  useTrackedValue('ui.state', 'changed', 'silicon.glow', glow);
  useTrackedValue('ui.state', 'changed', 'silicon.bloom', bloom);
  useTrackedValue('ui.state', 'changed', 'silicon.section', section);
  useTrackedValue('ui.state', 'changed', 'silicon.autoRotate', autoRotate);
  useTrackedValue('ui.state', 'changed', 'silicon.fullscreen', fullscreen);
  useTrackedValue('ui.state', 'changed', 'silicon.destination', destination);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let engine: SiliconEngine | null = null;
    let cancelled = false;
    // three.js and the generators load with the view, not with the Studio.
    import('./silicon/engine').then(({ createSiliconEngine }) => {
      if (cancelled) return;
      try {
        engine = createSiliconEngine(host, {
          onHud: setHud,
          onReady: () => setReady(true),
          onError: setError,
          onCameraGesture: (details) => getUiAudit()?.interaction('camera', details, { type: 'control', id: 'Silicon macro camera' }),
        });
        engineRef.current = engine;
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }, (reason: unknown) => setError(`The 3D engine failed to load: ${reason instanceof Error ? reason.message : String(reason)}`));
    return () => {
      cancelled = true;
      engine?.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => { engineRef.current?.setGlow(glow); }, [glow, ready]);
  useEffect(() => { engineRef.current?.setBloom(bloom); }, [bloom, ready]);
  useEffect(() => { engineRef.current?.setSection(section); }, [section, ready]);
  useEffect(() => { engineRef.current?.setAutoRotate(autoRotate); }, [autoRotate, ready]);

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

  return (
    <section className={`silicon-shell${fullscreen ? ' fullscreen' : ''}`} ref={shellRef} data-audit-area="Silicon macro">
      <div
        className="silicon-canvas"
        ref={hostRef}
        role="img"
        aria-label="Interactive macro view of the accelerator die: a procedurally generated metal stack, standard cells, transistors, TSVs, and deep-trench capacitors that you can zoom from the whole package down to single gates"
      />

      <div className="silicon-top">
        <div className="silicon-toolbar" role="toolbar" aria-label="Silicon macro view controls">
          <button onClick={() => fly('die')} title="Fly back to the whole die">Fit</button>
          <button className={glow ? 'active' : ''} aria-pressed={glow} onClick={() => setGlow((value) => !value)} title="Animated data pulses on active wires">Glow</button>
          <button className={bloom ? 'active' : ''} aria-pressed={bloom} onClick={() => setBloom((value) => !value)} title="Bloom on the glowing pathways">Bloom</button>
          <button className={section ? 'active' : ''} aria-pressed={section} onClick={() => setSection((value) => !value)} title="Cut a vertical section through the target to show the layer stack and deep trenches">Cross-section</button>
          <button className={autoRotate ? 'active' : ''} aria-pressed={autoRotate} onClick={() => setAutoRotate((value) => !value)}>Orbit</button>
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

      <div className="silicon-hud">
        {/* Announced only when the scale stop changes, not on every zoom tick. */}
        <div aria-live="polite">
          <span className="silicon-kicker">{hud ? hud.stop.label : 'Die'}</span>
          <strong>{hud ? hud.stop.layer : 'Global power mesh, seal ring, and I/O pads'}</strong>
        </div>
        <p>{!hud || hud.stop.id === 'package' || hud.stop.id === 'die' ? DIE_CAPTION : hud.location.join(' › ')}</p>
        {hud && (
          <div className="silicon-scale" aria-label={`Scale bar: ${hud.scale.label}`}>
            <i style={{ width: `${Math.round(hud.scale.px)}px` }} />
            <span>{hud.scale.label}</span>
          </div>
        )}
      </div>

      <div className="silicon-meta">
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

      <div className="silicon-help">Drag to orbit · right-drag to pan · scroll or pinch to zoom toward the cursor · double-click to dive, shift-double-click to back out</div>

      {!ready && !error && <div className="silicon-status">Growing the silicon…</div>}
      {error && <div className="silicon-status error" role="alert">{error}</div>}
    </section>
  );
}
