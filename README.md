# HY-World 2.0 Playground

A one-click local web UI for running Tencent's **WorldMirror 2.0** — images or a video in, 3D Gaussian Splats, point clouds, depth, normals, and camera poses out. Every modality, every parameter, every past run exposed in a fast Vite + TypeScript frontend over a FastAPI backend. Patched to run on Blackwell GPUs and on Windows without flash-attn.

[![Upstream](https://img.shields.io/badge/Upstream-Tencent%20HY--World%202.0-0052CC?style=for-the-badge&logo=github)](https://github.com/Tencent-Hunyuan/HY-World-2.0)
[![Patreon](https://img.shields.io/badge/Support%20Me-Patreon-F96854?style=for-the-badge&logo=patreon&logoColor=white)](https://www.patreon.com/Machinedelusions)
[![License](https://img.shields.io/badge/License-Tencent%20HY%20%2B%20MIT-brightgreen?style=for-the-badge)](#license)

![HY-World 2.0 Playground](assets/radme.png)

## Features

- **One-click install + run** — `install.bat` / `install.sh` sets up a venv, pulls CUDA torch, compiles gsplat for your GPU, and runs `npm install`. Then `run.bat` / `run.sh` kills the ports, launches backend + frontend, done.
- **22 bundled example scenes** — realistic rooms, landscapes, stylized characters. Thumbnail grid, click-to-select, live search filter.
- **Drag-and-drop uploads** — drop a folder of images or a single video file; frames get extracted automatically.
- **3D Gaussian Splat viewer** — pre-activated `.splat` binary served over the wire, no sigmoid/SH interpretation for the browser to get wrong.
- **Point cloud, depth, and normal viewers** — click any depth/normal tile to open a side-by-side source-vs-output inspector with arrow-key navigation.
- **Camera frustum overlay** — see where WorldMirror placed the cameras in the 3D scene. Toggle on/off in the splat view.
- **Live job progress** — status pill updates through the pipeline's phases (`Loading input` → `Inferring` → `Writing Gaussian splats` → `Done`).
- **Full job history** — every past run rehydrated from disk on startup with thumbnail, splat count, frame count, elapsed, size. Click to reload instantly.
- **Rerun with one click** — re-fires any completed job with its exact parameters.
- **Every pipeline param exposed** — 28 parameters across Outputs, Masks, Compression, Video input, and Rendered video, organized in collapsible Advanced sections.

## Quick Start

### Windows

```
install.bat
run.bat
```

### Linux / WSL

```
./install.sh
./run.sh
```

Then open **http://localhost:5173**. Pick a scene, hit **Run inference**. Watch it reconstruct!

The model weights (~2.4 GB) download from HuggingFace on the first run and cache to `~/.cache/huggingface/`.

## What's different from upstream

| Change | Why |
| --- | --- |
| torch 2.7+cu128 (not 2.4+cu124) | Native kernels for Turing → Blackwell (upstream's torch 2.4 caps at sm_90) |
| Auto-detected `TORCH_CUDA_ARCH_LIST` at install time | `scripts/setup_gpu.py` picks the right arch per GPU and writes `.cuda_arch`; install + runtime stay in sync. Blackwell gets sm_90+PTX (driver JITs at first call) since nvcc 12.6 doesn't know compute_120. |
| MSVC-compatible flags in gsplat build | Upstream passes `-Wno-attributes` (GCC) to `cl.exe` |
| flash-attn → PyTorch SDPA fallback | No flash-attn wheel for torch 2.7+cu128 on Windows |
| `tempfile.gettempdir()` for video frames | Upstream hardcoded `/tmp` (doesn't exist on Windows) |
| Filename sanitizer for uploads | Trailing dots in video filenames desync Windows `mkdir` from `open` |
| Pre-activated `.splat` binary endpoint | Upstream's `gaussians.ply` stores sigmoid-activated opacity; any viewer that sigmoids again squashes everything to a translucent haze |
| Server-side PLY Y-flip + quaternion rotation | Upstream world frame is Y-down; viewers expect Y-up |
| NaN/Inf gaussian filter + splat cap | Video-derived scenes occasionally produce bad depths → OOB in the viewer's WASM sort worker |

## Requirements

- **Python 3.10** (the gsplat wheel is `cp310`; the Windows installer uses `py -3.10`)
- **Node 18+** for Vite
- **NVIDIA driver 550+** (for CUDA 12.8 runtime)
- **NVIDIA GPU** — any generation from Turing onwards. The install script auto-detects your GPU and compiles gsplat for the right arch:

  | Generation | Example cards | Compute capability |
  | --- | --- | --- |
  | Turing | RTX 20xx, T4, GTX 16xx, Quadro RTX | sm_75 |
  | Ampere | RTX 30xx, A100, A40, A6000 | sm_80 / sm_86 |
  | Ada Lovelace | RTX 40xx, L40 | sm_89 |
  | Hopper | H100, H200 | sm_90 |
  | Blackwell | RTX 50xx, RTX PRO 6000 Blackwell, B200 | sm_100 / sm_120 (via sm_90 PTX JIT) |

  Pascal (10xx) and Volta (V100) also work — the script falls back to a broader arch list that includes them.

- **~6 GB VRAM** minimum for small scenes; **8–12 GB+** recommended for long-video or 32-frame reconstructions
- **CUDA 12.6+ toolkit** (NVCC) available on PATH for the gsplat build step
- **Visual Studio 2022 Build Tools** on Windows (C++ workload) — needed for the MSVC compiler gsplat's CUDA extension calls out to

## Architecture

```
hyworld2/                       # upstream WorldMirror 2.0 model code
  worldrecon/                   # (+2 modified files — see NOTICE)
app/
  backend/   main.py            # FastAPI: /examples, /infer, /jobs, /gaussians.splat
  frontend/  src/main.ts        # Vite + vanilla TS + @mkkellogg/gaussian-splats-3d
             src/viewer.ts      # Splat + point-cloud viewers, frustum overlay
             src/icons.ts       # 28 inline-SVG icons
scripts/    patch_requirements_windows.py   # swaps linux gsplat wheel → win wheel
            compile_gsplat.bat              # MSVC + CUDA 12.6 build wrapper
install.{bat,sh}                # venv + torch cu128 + gsplat compile + npm i
run.{bat,sh}                    # kill ports, launch backend + frontend
```

## License

- **Model + upstream code** (`hyworld2/`, `examples/`, `License.txt`): **Tencent HY-WORLD 2.0 Community License Agreement**. See `License.txt` and `NOTICE`. **Not available in the EU, UK, or South Korea.**
- **Playground code** added in this repo (`app/`, `scripts/`, `install.*`, `run.*`, this README, `NOTICE`): **MIT** — see `LICENSE-playground.md`.

Powered by **Tencent HY**. Built by [filliptm](https://github.com/filliptm) / [Machine Delusions](https://www.patreon.com/Machinedelusions).
