#!/usr/bin/env python3
"""C3: project the A1 tile's area, clock and energy to an IRDS 3 nm-class node.

Method (fixed in C0, docs/compute-die/C0_RESEARCH_DOSSIER.md section 6): run the same
tile on ASAP7 and GT2N, take the range between them, adjusted by IRDS pitch ratios, and
label it `modeled` ("predictive, not foundry").

- Pitch coordinate: p = gate pitch x tightest metal pitch (nm^2). ASAP7 G54M36 = 1,944;
  GT2N G42M24 = 1,008; IRDS 3nm+ G48M24 = 1,152.
- Area: dense logic scales with p at a fixed cell architecture. Scale each endpoint to the
  target pitches. From ASAP7 (7.5 tracks, frontside power) gives the high bound; from GT2N
  (6 tracks, backside power) the low bound. The spread is the cell-architecture question
  (tracks, backside power), which pitch alone does not decide. Central = geometric mean.
- Clock and energy per cycle: no pitch law, so interpolate in log space between the two
  measured endpoints at t along ln p (central). The band uses t from gate pitch alone and
  from metal pitch alone.
All inputs come from design/physical/projection/c3-inputs.json; see the caveats it carries.
"""
import json, math, sys

def main(inputs_path, out_path):
    cfg = json.load(open(inputs_path))
    a7, g2, tgt = cfg['endpoints']['asap7'], cfg['endpoints']['gt2n'], cfg['target']
    prod = lambda e: e['gate_pitch_nm'] * e['tightest_metal_pitch_nm']
    p7, p2, p3 = prod(a7), prod(g2), prod(tgt)
    frac = lambda lo, x, hi: math.log(lo / x) / math.log(lo / hi)
    t_mid = frac(p7, p3, p2)
    t_gate = frac(a7['gate_pitch_nm'], tgt['gate_pitch_nm'], g2['gate_pitch_nm'])
    t_metal = frac(a7['tightest_metal_pitch_nm'], tgt['tightest_metal_pitch_nm'], g2['tightest_metal_pitch_nm'])
    t_lo, t_hi = min(t_gate, t_metal), max(t_gate, t_metal)
    lerp = lambda x7, x2, t: math.exp((1 - t) * math.log(x7) + t * math.log(x2))

    area_hi = a7['cell_area_um2'] * p3 / p7
    area_lo = g2['cell_area_um2'] * p3 / p2
    area = math.sqrt(area_hi * area_lo)
    e7 = a7['power_w'] * a7['power_clock_period_ns'] * 1e3   # pJ per cycle
    e2 = g2['power_w'] * g2['power_clock_period_ns'] * 1e3
    f = {k: lerp(a7['fmax_mhz'], g2['fmax_mhz'], t) for k, t in (('low', t_lo), ('central', t_mid), ('high', t_hi))}
    e = {k: lerp(e7, e2, t) for k, t in (('high', t_lo), ('central', t_mid), ('low', t_hi))}
    area_b = {'low': area_lo, 'central': area, 'high': area_hi}

    derived = {}
    for fmt, flop in cfg['flops_per_cycle'].items():
        if fmt == 'comment':
            continue
        derived[fmt] = {
            'tflops_per_tile': {k: flop * f[k] * 1e6 / 1e12 for k in f},
            # FLOP per pJ = TFLOPS per W; the lowest energy gives the best efficiency
            'tflops_per_w': {'worst': flop / e['high'], 'central': flop / e['central'], 'best': flop / e['low']},
            'tflops_per_mm2': {'central': flop * f['central'] * 1e6 / 1e12 / (area * 1e-6)},
        }
    out = {
        'label': 'modeled',
        'qualifier': 'predictive, not foundry: interpolated between two academic PDKs (ASAP7, GT2N) to IRDS 3nm+ pitches',
        'method': __doc__.strip(),
        'pitch_products_nm2': {'asap7': p7, 'target_3nm': p3, 'gt2n': p2},
        't': {'central_pitch_product': t_mid, 'gate_pitch_only': t_gate, 'metal_pitch_only': t_metal},
        'cell_area_um2': area_b,
        'fmax_mhz': f,
        'energy_per_cycle_pj': e,
        'derived': derived,
        'caveats': [
            'Power uses OpenSTA default switching activity, not a workload trace; energy per cycle is taken as format-independent.',
            'GT2N numbers are post-global-route estimates (detailed routing did not fit in 39 GB); its clock end is optimistic.',
            'ASAP7 was optimised at its BC corner and re-timed at TT; its clock end is pessimistic.',
            'Tile only: no operand memory, DMA, interconnect or clock tree beyond the tile.',
            "The tile's slowest path is stage 2 (17-term align and sum) on every kit; rebalancing the pipeline is a C4 lever.",
        ],
        'inputs': inputs_path,
    }
    json.dump(out, open(out_path, 'w'), indent=2)
    r = lambda d, k='central': round(d[k], 1)
    print(f"t: central {t_mid:.3f}, band {t_lo:.3f}-{t_hi:.3f}")
    print(f"cell area um2: {area_lo:.0f} / {area:.0f} / {area_hi:.0f}  (low / central / high)")
    print(f"fmax MHz: {f['low']:.1f} / {f['central']:.1f} / {f['high']:.1f}")
    print(f"energy pJ/cycle: {e['low']:.1f} / {e['central']:.1f} / {e['high']:.1f}")
    for fmt, d in derived.items():
        w = d['tflops_per_w']
        print(f"{fmt}: TFLOPS/tile {d['tflops_per_tile']['central']:.4f}, TFLOPS/W {w['worst']:.3f} / {w['central']:.3f} / {w['best']:.3f} (worst / central / best), TFLOPS/mm2 {d['tflops_per_mm2']['central']:.2f}")

if __name__ == '__main__':
    main(*(sys.argv[1:3] if len(sys.argv) > 2 else ['design/physical/projection/c3-inputs.json', 'design/physical/projection/c3-projection-3nm.json']))
