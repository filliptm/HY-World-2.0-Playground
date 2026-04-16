"""Detect the installed GPU and pick an appropriate TORCH_CUDA_ARCH_LIST.

Why this script exists
----------------------
gsplat compiles CUDA kernels on first import via torch's cpp_extension system.
If `TORCH_CUDA_ARCH_LIST` is unset, torch infers archs from the visible GPU(s)
and asks nvcc to emit native SASS for that arch. That fails in two common
scenarios we care about:

  * Blackwell (sm_100 / sm_120) — nvcc 12.6 and older don't know `compute_120`,
    so native compilation aborts with "Unsupported gpu architecture". We work
    around this by compiling for sm_90 and including PTX; the NVIDIA driver
    JIT-compiles the PTX to native SASS on first kernel launch (Blackwell is
    forward-compatible with sm_90 PTX).

  * Older cards (Ampere / Ada / Turing) — if someone else previously compiled
    gsplat for `9.0+PTX` on a Blackwell machine, the cached build won't run on
    sm_86 / 8.9 / 7.5 (PTX is only forward-compatible). They need the arch
    compiled natively.

So: we detect, pick the right arch string, and write it to `.cuda_arch` at the
repo root. Install/run scripts and the backend read that file and export
`TORCH_CUDA_ARCH_LIST` accordingly — keeping build-time and run-time consistent.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
ARCH_FILE = REPO_ROOT / ".cuda_arch"

# Fallback if we can't detect a GPU: broad enough to cover anything from Turing
# up to Hopper natively, with PTX for Blackwell forward-compat.
FALLBACK_MULTI_ARCH = "7.5;8.0;8.6;8.9;9.0+PTX"


def pick_arch_list() -> tuple[str, str]:
    """Returns (arch_list, human_reason) for the detected GPU."""
    try:
        import torch
    except ImportError:
        return FALLBACK_MULTI_ARCH, "torch not installed; using broad fallback"

    if not torch.cuda.is_available():
        return FALLBACK_MULTI_ARCH, "no CUDA device visible; using broad fallback"

    try:
        major, minor = torch.cuda.get_device_capability(0)
        name = torch.cuda.get_device_name(0)
    except Exception as exc:  # noqa: BLE001
        return FALLBACK_MULTI_ARCH, f"capability probe failed ({exc}); using fallback"

    cap = f"{major}.{minor}"

    # Blackwell (sm_100/101 datacenter, sm_120 consumer/pro).
    # Nvcc < 12.8 doesn't know compute_100/120; use sm_90 + PTX and let the
    # driver JIT at runtime. Negligible perf cost after first kernel launch.
    if major >= 10:
        return "9.0+PTX", f"{name} (sm_{major}{minor}) — Blackwell via sm_90 PTX JIT"

    # Anything pre-Turing (sm_7.0 Volta, sm_6.x Pascal): gsplat still builds fine
    # but include a broad list so we cover adjacent generations too.
    if major < 7 or (major == 7 and minor < 5):
        return f"{cap};{FALLBACK_MULTI_ARCH}", f"{name} (sm_{major}{minor}) — pre-Turing, building broad"

    # Turing (7.5), Ampere (8.0/8.6/8.7), Ada (8.9), Hopper (9.0):
    # native cubin + PTX for forward-compat.
    return f"{cap}+PTX", f"{name} (sm_{major}{minor}) — native + PTX forward-compat"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true", help="Write result to .cuda_arch")
    parser.add_argument("--quiet", action="store_true", help="Only print the arch string")
    args = parser.parse_args()

    arch, reason = pick_arch_list()

    if args.quiet:
        print(arch)
    else:
        print(f"Detected: {reason}")
        print(f"TORCH_CUDA_ARCH_LIST={arch}")

    if args.write:
        ARCH_FILE.write_text(arch + "\n", encoding="utf-8")
        if not args.quiet:
            print(f"Wrote {ARCH_FILE}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
