"""Best MLPerf Inference result per chip, model, and scenario (the "frontier").

Used by C1 version 3 of the compute-die plan (docs/COMPUTE_DIE_PLAN.md): each chip is scored
against its best closed-division, generally available submission, because the same hardware
spreads widely across submitters while the best submissions cluster within a few percent.

Usage: python3 tools/mlperf/extract_frontier.py CACHE_DIR > frontier.json
Downloads the MLCommons summary files into CACHE_DIR (skipped if already present). Stdlib only.
"""

import csv
import json
import re
import sys
import urllib.request
from pathlib import Path

SUMMARIES = {
    "v5.0": "https://raw.githubusercontent.com/mlcommons/inference_results_v5.0/main/summary_results.json",
    "v5.1": "https://raw.githubusercontent.com/mlcommons/inference_results_v5.1/main/summary_results.json",
    "v6.0": "https://raw.githubusercontent.com/mlcommons/inference_results_v6.0/main/summary_results.json",
    "v6.1": "https://raw.githubusercontent.com/mlcommons/inference_results_v6.1/main/summary.csv",
}

# Exact MLPerf accelerator names per chip. Mixed-accelerator systems, virtualized systems,
# power-capped variants, and other SKUs (PCIe, NVL, GH200) are excluded by exact matching.
CHIPS = {
    "h100-sxm": [r"NVIDIA H100-SXM-80GB"],
    "h200-sxm": [r"NVIDIA H200-SXM-141GB"],
    "b200-hgx": [r"NVIDIA B200-SXM-180GB"],
    "b300-hgx": [r"NVIDIA B300-SXM-270GB"],
    "gb200-nvl": [r"NVIDIA GB200"],
    "gb300-nvl72": [r"NVIDIA GB300"],
    "mi355x": [r"AMD Instinct MI355X 288GB HBM3e", r"AMD Instinct MI355X 288GB HBM3e \(x\d+\)"],
}
MODELS = ("llama2-70b-99", "llama3.1-405b")
SCENARIOS = ("Offline", "Server")


def chip_of(accelerator):
    for chip, patterns in CHIPS.items():
        if any(re.fullmatch(pattern, accelerator.strip()) for pattern in patterns):
            return chip
    return None


def tokens_per_sample(accuracy):
    match = re.search(r"TOKENS_PER_SAMPLE: ([\d.]+)", accuracy or "")
    return float(match.group(1)) if match else None


def load(cache):
    cache.mkdir(parents=True, exist_ok=True)
    rows = []
    for round_, url in SUMMARIES.items():
        path = cache / f"mlperf-{round_}{Path(url).suffix}"
        if not path.exists():
            urllib.request.urlretrieve(url, path)
        if path.suffix == ".json":
            for r in json.loads(path.read_text()):
                if r.get("Category") != "closed" or r.get("Availability") != "available":
                    continue
                accelerators = r.get("Total Accelerators") or (r["a#"] * (r.get("Nodes") or 1) if isinstance(r.get("a#"), int) else None)
                rows.append(dict(round=round_, id=r["ID"], submitter=r["Submitter"], system=r["System"], accelerator=r["Accelerator"],
                                 model=r["Model"], scenario=r["Scenario"], result=float(r["Performance_Result"]), accelerators=accelerators,
                                 weights=r.get("weight_data_types"), tokens=tokens_per_sample(r.get("Accuracy"))))
        else:
            with path.open(newline="") as handle:
                for r in csv.DictReader(handle):
                    if r["Division"] != "closed" or r["Availability"] != "available":
                        continue
                    rows.append(dict(round=round_, id=None, submitter=r["Organization"], system=r["SystemName"], accelerator=r["accelerator_model_name"],
                                     model=r["Model"], scenario=r["Scenario"], result=float(r["Result"]), accelerators=int(r["total_accelerators"]),
                                     weights=r.get("weight_data_types"), tokens=tokens_per_sample(r.get("Accuracy"))))
    return rows


def frontier(rows):
    groups = {}
    for row in rows:
        chip = chip_of(row["accelerator"])
        if not chip or row["model"] not in MODELS or row["scenario"] not in SCENARIOS or not row["accelerators"]:
            continue
        row = dict(row, per_accelerator=row["result"] / row["accelerators"])
        groups.setdefault((chip, row["model"], row["scenario"]), []).append(row)
    out = []
    for (chip, model, scenario), group in sorted(groups.items()):
        group.sort(key=lambda row: row["per_accelerator"])
        best = group[-1]
        out.append({
            "chip": chip,
            "model": model,
            "scenario": scenario,
            "best_per_accelerator": round(best["per_accelerator"], 3),
            "system_result_tokens_per_s": best["result"],
            "accelerators": best["accelerators"],
            "weights": best["weights"],
            "mean_output_tokens": best["tokens"],
            "best_submission": {"round": best["round"], "id": best["id"], "submitter": best["submitter"], "system": best["system"]},
            "submissions_considered": len(group),
            "median_per_accelerator": round(group[len(group) // 2]["per_accelerator"], 3),
        })
    return out


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    json.dump(frontier(load(Path(sys.argv[1]))), sys.stdout, indent=2)
    sys.stdout.write("\n")
