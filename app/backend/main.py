"""FastAPI backend for HY-World 2.0 WorldMirror inference."""
from __future__ import annotations

import asyncio
import io
import json
import shutil
import sys
import threading
import time
import traceback
import uuid
import zipfile
from contextlib import asynccontextmanager
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

import os as _os

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

# Keep the gsplat build-time and run-time arch lists in sync. `install.*` runs
# `scripts/setup_gpu.py --write`, which detects the GPU and writes the right
# TORCH_CUDA_ARCH_LIST to `.cuda_arch`. If the user already set the env var
# themselves (setdefault respects that), leave it alone.
_arch_file = REPO_ROOT / ".cuda_arch"
if _arch_file.exists():
    _os.environ.setdefault("TORCH_CUDA_ARCH_LIST", _arch_file.read_text().strip())
else:
    # Blackwell-safe fallback: sm_90 cubin + PTX that the driver JITs to sm_100/120.
    _os.environ.setdefault("TORCH_CUDA_ARCH_LIST", "9.0+PTX")

APP_ROOT = Path(__file__).resolve().parent
JOBS_DIR = APP_ROOT / "jobs"
UPLOADS_DIR = APP_ROOT / "uploads"
JOBS_DIR.mkdir(parents=True, exist_ok=True)
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

EXAMPLES_ROOT = REPO_ROOT / "examples" / "worldrecon"

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}


# ---------------------------------------------------------------
# Job registry
# ---------------------------------------------------------------
@dataclass
class Job:
    id: str
    status: str = "queued"  # queued | running | done | error
    progress: float = 0.0
    stage: str = ""            # coarse phase: preparing | inferring | post | saving | rendering
    message: str = ""          # last line pipeline emitted (human-readable detail)
    error: str = ""
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    input_dir: str | None = None
    output_dir: str | None = None
    params: dict[str, Any] = field(default_factory=dict)
    files: list[dict[str, Any]] = field(default_factory=list)

    # Source tracking — what was fed in, so the frontend can offer Rerun.
    source_kind: str = "unknown"   # "example" | "upload"
    source_ref: str = ""           # "category/scene" for example; filename for upload
    source_label: str = ""         # pretty display name
    thumbnail: str | None = None   # URL the history list can show

    # Output metadata computed after a successful run.
    splat_count: int | None = None   # exact # gaussians in the cached .splat
    frame_count: int | None = None   # # of input frames the model saw

    def public(self) -> dict[str, Any]:
        d = asdict(self)
        return d


JOBS: dict[str, Job] = {}
JOBS_LOCK = threading.Lock()

# Serialize inference to one GPU job at a time.
INFER_LOCK = threading.Lock()


# ---------------------------------------------------------------
# Lazy pipeline singleton
# ---------------------------------------------------------------
class PipelineHolder:
    def __init__(self) -> None:
        self.pipeline = None
        self.error: str | None = None
        self.loading = False
        self.lock = threading.Lock()

    def get(self):
        with self.lock:
            if self.pipeline is not None:
                return self.pipeline
            if self.error:
                raise RuntimeError(self.error)
            self.loading = True
        try:
            from hyworld2.worldrecon.pipeline import WorldMirrorPipeline  # noqa: WPS433
            pipeline = WorldMirrorPipeline.from_pretrained(
                pretrained_model_name_or_path="tencent/HY-World-2.0",
                subfolder="HY-WorldMirror-2.0",
                enable_bf16=True,
            )
            with self.lock:
                self.pipeline = pipeline
                self.loading = False
            return pipeline
        except Exception as exc:  # noqa: BLE001
            msg = f"{type(exc).__name__}: {exc}"
            traceback.print_exc()
            with self.lock:
                self.error = msg
                self.loading = False
            raise

    def status(self) -> dict[str, Any]:
        with self.lock:
            return {
                "loaded": self.pipeline is not None,
                "loading": self.loading,
                "error": self.error,
            }


HOLDER = PipelineHolder()


# ---------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------
def list_examples() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not EXAMPLES_ROOT.exists():
        return out
    for category_dir in sorted(EXAMPLES_ROOT.iterdir()):
        if not category_dir.is_dir():
            continue
        for scene_dir in sorted(category_dir.iterdir()):
            if not scene_dir.is_dir():
                continue
            images = sorted(
                p for p in scene_dir.iterdir()
                if p.suffix.lower() in IMAGE_EXTS
            )
            if not images:
                continue
            rel = scene_dir.relative_to(REPO_ROOT).as_posix()
            out.append({
                "id": f"{category_dir.name}/{scene_dir.name}",
                "name": scene_dir.name.replace("_", " "),
                "category": category_dir.name,
                "image_count": len(images),
                "thumbnail": f"/api/examples/{category_dir.name}/{scene_dir.name}/image/{images[0].name}",
                "path": rel,
            })
    return out


def resolve_example_dir(category: str, scene: str) -> Path:
    target = EXAMPLES_ROOT / category / scene
    target = target.resolve()
    if not target.is_dir() or EXAMPLES_ROOT.resolve() not in target.parents and target != EXAMPLES_ROOT.resolve():
        raise HTTPException(404, "example not found")
    return target


def scan_output_files(out_dir: Path) -> list[dict[str, Any]]:
    if not out_dir.exists():
        return []
    results: list[dict[str, Any]] = []
    for p in sorted(out_dir.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(out_dir).as_posix()
        results.append({
            "name": rel,
            "size": p.stat().st_size,
            "suffix": p.suffix.lower(),
        })
    return results


class _StageStream:
    """Forwards writes to the original stdout while extracting stage markers.

    WorldMirror's pipeline prints human-readable phase markers as it runs (e.g.
    `[Input] Loaded N images...`, `[Inference] Adaptive resolution: ...`,
    `[Save] gaussians.ply (...)`, `[Pipeline] Results saved to: ...`). We tee
    stdout so we can update the job's `.stage`/`.message` live without patching
    upstream code.
    """

    _STAGE_PATTERNS = (
        # (substring found in a pipeline print line, coarse stage key, pretty message)
        ("[Init] Downloading", "downloading", "Downloading model from HuggingFace"),
        ("[Input] Loaded",     "preparing",  "Loading input images"),
        ("[Input] Extracted",  "preparing",  "Extracting video frames"),
        ("[Input] Single image", "preparing","Preparing single image"),
        ("[Inference] Adaptive resolution", "inferring", "Inferring"),
        ("[Memory]",           "inferring",  "Running model forward pass"),
        ("compute_mask",       "post",       "Post-processing masks"),
        ("[Save] gaussians.ply","saving",    "Writing Gaussian splats"),
        ("[Save] Downsample gaussians","saving","Compressing gaussians"),
        ("save_gs_ply",        "saving",     "Writing Gaussian splats"),
        ("save_points",        "saving",     "Writing point cloud"),
        ("[Save]",             "saving",     "Saving outputs"),
        ("render_interpolated_video", "rendering", "Rendering fly-through video"),
        ("[Pipeline] Results saved", "saving", "Finalizing"),
    )

    def __init__(self, job: Job, original):
        self._job = job
        self._orig = original
        self._buf = ""

    def write(self, s: str) -> int:
        try:
            self._orig.write(s)
        except Exception:
            pass
        self._buf += s
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            self._process(line)
        return len(s)

    def flush(self) -> None:
        try:
            self._orig.flush()
        except Exception:
            pass

    def _process(self, line: str) -> None:
        for needle, stage, pretty in self._STAGE_PATTERNS:
            if needle in line:
                self._job.stage = stage
                self._job.message = pretty
                return


def _copy_input_frames(job: Job) -> int:
    """Copy the frames the model actually saw into job_dir/frames/.

    Lets the depth/normal inspector show a real source-vs-output side-by-side.
    Matches the file count to the number of depth maps produced so the pairing
    is consistent.
    """
    import tempfile
    if not job.output_dir or not job.input_dir:
        return 0
    out_dir = Path(job.output_dir)
    dst = out_dir / "frames"
    dst.mkdir(exist_ok=True)

    depth_count = sum(1 for p in (out_dir / "depth").glob("*.png")) if (out_dir / "depth").exists() else 0
    if depth_count == 0:
        return 0

    src_path = Path(job.input_dir)
    srcs: list[Path] = []
    if src_path.is_dir():
        for ext in (".jpg", ".jpeg", ".png", ".webp"):
            srcs.extend(sorted(src_path.glob(f"*{ext}")))
            srcs.extend(sorted(src_path.glob(f"*{ext.upper()}")))
    elif src_path.is_file() and src_path.suffix.lower() in VIDEO_EXTS:
        # Match the same sanitization the patched prepare_input applies.
        import re as _re
        stem = _re.sub(r'[<>:"/\\|?*]', "_", src_path.stem).rstrip(" .")[:80] or "video"
        frames_dir = Path(tempfile.gettempdir()) / f"frames_{stem}"
        if frames_dir.is_dir():
            srcs = sorted(frames_dir.glob("frame_*.jpg"))

    if not srcs:
        return 0

    # Sample evenly to match depth_count. If we have >= depth_count we likely
    # want the same frames the model picked, but we don't have that index;
    # even spacing is a good approximation.
    if len(srcs) > depth_count:
        step = len(srcs) / depth_count
        srcs = [srcs[int(i * step)] for i in range(depth_count)]

    written = 0
    for i, src in enumerate(srcs[:depth_count]):
        out = dst / f"frame_{i:04d}{src.suffix.lower()}"
        try:
            shutil.copyfile(src, out)
            written += 1
        except Exception:
            pass
    return written


def _safe_filename(name: str) -> str:
    """Sanitize an uploaded filename for cross-platform storage.

    Windows is the strict one: forbids <>:"/\\|?* and silently strips trailing
    dots/spaces during mkdir — which desyncs from open() and breaks downstream.
    """
    name = name.replace("\\", "_").replace("/", "_")
    name = "".join(c for c in name if c.isalnum() or c in "._- ")
    name = name.rstrip(" .")  # Windows refuses trailing dots/spaces in filenames
    return name or "file"


# ---------------------------------------------------------------
# Inference runner
# ---------------------------------------------------------------
def run_inference(job: Job) -> None:
    job.started_at = time.time()
    job.status = "running"
    job.stage = "loading"
    job.message = "Loading pipeline"

    try:
        pipeline = HOLDER.get()
    except Exception as exc:  # noqa: BLE001
        job.status = "error"
        job.error = f"Pipeline load failed: {exc}"
        job.finished_at = time.time()
        return

    job.stage = "preparing"
    job.message = "Preparing input"
    job.progress = 0.1

    params = dict(job.params)
    input_path = job.input_dir
    output_root = Path(job.output_dir).parent
    output_root.mkdir(parents=True, exist_ok=True)

    # Tee stdout so we can capture pipeline's phase-marker prints.
    original_stdout = sys.stdout
    stream = _StageStream(job, original_stdout)
    sys.stdout = stream  # type: ignore[assignment]

    try:
        with INFER_LOCK:
            pipeline(
                input_path=input_path,
                output_path=str(output_root),
                strict_output_path=job.output_dir,
                **params,
            )
        sys.stdout = original_stdout

        job.stage = "saving"
        job.message = "Copying source frames"
        try:
            n = _copy_input_frames(job)
            if n:
                print(f"[backend] copied {n} frame(s) to frames/")
        except Exception as exc:  # noqa: BLE001
            print(f"[backend] frame copy failed: {exc}")

        # Eagerly generate the viewer-ready .splat so the frontend chip
        # can show exact count and first-view is fast.
        out_dir = Path(job.output_dir)
        gs_src = out_dir / "gaussians.ply"
        if gs_src.is_file():
            try:
                cap = DEFAULT_VIEWER_SPLAT_CAP
                splat_dst = out_dir / f"gaussians_view_cap{cap}.splat"
                count = _worldmirror_ply_to_splat(gs_src, splat_dst, max_splats=cap)
                job.splat_count = count
            except Exception as exc:  # noqa: BLE001
                print(f"[backend] .splat pre-gen failed: {exc}")

        # Frame count = number of depth maps produced.
        if (out_dir / "depth").exists():
            job.frame_count = sum(1 for _ in (out_dir / "depth").glob("*.png"))

        # Set a thumbnail if we don't already have one (example jobs do).
        if not job.thumbnail:
            frames_dir = out_dir / "frames"
            if frames_dir.exists():
                frames = sorted(frames_dir.iterdir())
                if frames:
                    job.thumbnail = f"/api/jobs/{job.id}/file/frames/{frames[0].name}"

        job.progress = 1.0
        job.status = "done"
        job.stage = "done"
        job.message = "Done"
        job.files = scan_output_files(out_dir)
    except Exception as exc:  # noqa: BLE001
        sys.stdout = original_stdout
        traceback.print_exc()
        job.status = "error"
        job.error = f"{type(exc).__name__}: {exc}"
    finally:
        sys.stdout = original_stdout
        job.finished_at = time.time()


# ---------------------------------------------------------------
# Parameter whitelist
# ---------------------------------------------------------------
ALLOWED_PARAMS = {
    "target_size": int,
    "fps": int,
    "video_strategy": str,
    "video_min_frames": int,
    "video_max_frames": int,
    "save_depth": bool,
    "save_normal": bool,
    "save_gs": bool,
    "save_camera": bool,
    "save_points": bool,
    "save_colmap": bool,
    "save_conf": bool,
    "apply_sky_mask": bool,
    "apply_edge_mask": bool,
    "apply_confidence_mask": bool,
    "save_sky_mask": bool,
    "sky_mask_source": str,
    "model_sky_threshold": float,
    "confidence_percentile": float,
    "edge_normal_threshold": float,
    "edge_depth_threshold": float,
    "compress_pts": bool,
    "compress_pts_max_points": int,
    "compress_pts_voxel_size": float,
    "max_resolution": int,
    "compress_gs_max_points": int,
    "save_rendered": bool,
    "render_interp_per_pair": int,
    "render_depth": bool,
}


def sanitize_params(raw: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, caster in ALLOWED_PARAMS.items():
        if k not in raw or raw[k] is None or raw[k] == "":
            continue
        try:
            if caster is bool:
                out[k] = bool(raw[k]) if not isinstance(raw[k], str) else raw[k].lower() in {"1", "true", "yes", "on"}
            else:
                out[k] = caster(raw[k])
        except (TypeError, ValueError):
            continue
    return out


# ---------------------------------------------------------------
# App
# ---------------------------------------------------------------
def _rehydrate_jobs() -> int:
    """Repopulate JOBS from existing output directories so /api/jobs/* keep
    working after backend restarts. Best-effort recovery of source metadata.
    """
    count = 0
    for out_dir in sorted(JOBS_DIR.iterdir()) if JOBS_DIR.exists() else []:
        if not out_dir.is_dir():
            continue
        jid = out_dir.name
        if jid in JOBS:
            continue
        files = scan_output_files(out_dir)
        if not files:
            continue
        stat = out_dir.stat()

        # Try to recover splat_count from cached .splat (32 bytes/gaussian).
        splat_count: int | None = None
        for f in files:
            if f["name"].startswith("gaussians_view_cap") and f["suffix"] == ".splat":
                splat_count = f["size"] // 32
                break

        # Frame count from depth maps.
        frame_count = sum(1 for f in files if f["name"].startswith("depth/") and f["suffix"] == ".png")

        # Thumbnail: first saved frame, or first depth map.
        thumb: str | None = None
        for f in files:
            if f["name"].startswith("frames/"):
                thumb = f"/api/jobs/{jid}/file/{f['name']}"
                break
        if thumb is None:
            for f in files:
                if f["name"].startswith("depth/") and f["suffix"] == ".png":
                    thumb = f"/api/jobs/{jid}/file/{f['name']}"
                    break

        JOBS[jid] = Job(
            id=jid,
            status="done",
            progress=1.0,
            message="rehydrated",
            stage="done",
            created_at=stat.st_mtime,
            started_at=stat.st_mtime,
            finished_at=stat.st_mtime,
            output_dir=str(out_dir),
            files=files,
            splat_count=splat_count,
            frame_count=frame_count or None,
            thumbnail=thumb,
            source_label="(rehydrated)",
        )
        count += 1
    return count


@asynccontextmanager
async def lifespan(app: FastAPI):
    print(f"[backend] repo root = {REPO_ROOT}")
    print(f"[backend] examples  = {EXAMPLES_ROOT} (exists={EXAMPLES_ROOT.exists()})")
    rehydrated = _rehydrate_jobs()
    if rehydrated:
        print(f"[backend] rehydrated {rehydrated} prior job(s) from disk")
    yield


app = FastAPI(title="HY-World 2.0 WorldMirror API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, Any]:
    try:
        import torch
        cuda = torch.cuda.is_available()
        dev_name = torch.cuda.get_device_name(0) if cuda else None
    except Exception as exc:  # noqa: BLE001
        cuda = False
        dev_name = f"torch unavailable: {exc}"
    return {
        "ok": True,
        "cuda": cuda,
        "device": dev_name,
        "pipeline": HOLDER.status(),
        "examples_count": len(list_examples()),
    }


@app.get("/api/examples")
def examples() -> list[dict[str, Any]]:
    return list_examples()


@app.get("/api/examples/{category}/{scene}/image/{filename}")
def example_image(category: str, scene: str, filename: str):
    d = resolve_example_dir(category, scene)
    target = (d / filename).resolve()
    if d.resolve() != target.parent or not target.is_file():
        raise HTTPException(404, "not found")
    return FileResponse(target)


@app.get("/api/examples/{category}/{scene}/images")
def example_images(category: str, scene: str) -> list[str]:
    d = resolve_example_dir(category, scene)
    return [p.name for p in sorted(d.iterdir()) if p.suffix.lower() in IMAGE_EXTS]


@app.post("/api/infer/example")
def infer_example(
    category: str = Form(...),
    scene: str = Form(...),
    params: str = Form("{}"),
) -> dict[str, Any]:
    d = resolve_example_dir(category, scene)
    try:
        raw = json.loads(params) if params else {}
    except json.JSONDecodeError:
        raise HTTPException(400, "invalid params JSON")
    safe = sanitize_params(raw)
    label = scene.replace("_", " ")
    thumb = f"/api/examples/{category}/{scene}/image/{sorted(p.name for p in d.iterdir() if p.suffix.lower() in IMAGE_EXTS)[0]}"
    return _start_job(
        input_dir=str(d),
        params=safe,
        source_kind="example",
        source_ref=f"{category}/{scene}",
        source_label=f"{label} ({category})",
        thumbnail=thumb,
    )


@app.post("/api/infer/upload")
async def infer_upload(
    files: list[UploadFile] = File(...),
    params: str = Form("{}"),
) -> dict[str, Any]:
    if not files:
        raise HTTPException(400, "no files uploaded")

    job_id = uuid.uuid4().hex[:12]
    upload_dir = UPLOADS_DIR / job_id
    upload_dir.mkdir(parents=True, exist_ok=True)

    saved = 0
    for f in files:
        safe = _safe_filename(f.filename or "file")
        if not safe:
            continue
        dest = upload_dir / safe
        data = await f.read()
        dest.write_bytes(data)
        saved += 1

    if saved == 0:
        shutil.rmtree(upload_dir, ignore_errors=True)
        raise HTTPException(400, "no valid files")

    # Detect if a single video was uploaded vs images
    contents = list(upload_dir.iterdir())
    if len(contents) == 1 and contents[0].suffix.lower() in VIDEO_EXTS:
        input_path = str(contents[0])
    else:
        input_path = str(upload_dir)

    try:
        raw = json.loads(params) if params else {}
    except json.JSONDecodeError:
        raise HTTPException(400, "invalid params JSON")
    safe = sanitize_params(raw)
    # Label = the first file/video name we saved.
    label = contents[0].name if contents else "upload"
    return _start_job(
        input_dir=input_path,
        params=safe,
        source_kind="upload",
        source_ref=label,
        source_label=label,
        existing_id=job_id,
    )


def _start_job(
    *,
    input_dir: str,
    params: dict[str, Any],
    source_kind: str,
    source_ref: str,
    source_label: str,
    thumbnail: str | None = None,
    existing_id: str | None = None,
) -> dict[str, Any]:
    job_id = existing_id or uuid.uuid4().hex[:12]
    out_dir = JOBS_DIR / job_id
    job = Job(
        id=job_id,
        input_dir=input_dir,
        output_dir=str(out_dir),
        params=params,
        message="queued",
        source_kind=source_kind,
        source_ref=source_ref,
        source_label=source_label,
        thumbnail=thumbnail,
    )
    with JOBS_LOCK:
        JOBS[job_id] = job

    t = threading.Thread(target=run_inference, args=(job,), daemon=True)
    t.start()

    return {"job_id": job_id, "status": job.status}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    if job.status == "done" and not job.files:
        job.files = scan_output_files(Path(job.output_dir))
    return job.public()


@app.get("/api/jobs")
def list_jobs() -> list[dict[str, Any]]:
    with JOBS_LOCK:
        jobs = list(JOBS.values())
    return [j.public() for j in sorted(jobs, key=lambda j: j.created_at, reverse=True)]


def _worldmirror_ply_to_splat(src: Path, dst: Path, max_splats: int | None = None) -> int:
    """Convert WorldMirror's gaussians.ply to antimatter15 `.splat` binary.

    The `.splat` format is 32 bytes/gaussian and stores already-activated values
    — pre-exponentiated scales, pre-SH'd RGB, pre-sigmoid opacity. That removes
    the activation ambiguity that was wrecking our direct-PLY path.

      position  : 3 × float32 = 12B
      scale     : 3 × float32 = 12B  (exp(log_scale))
      color     : 4 × uint8   = 4B   ((0.5 + SH_C0 * f_dc)*255, sigmoid(op)*255)
      rotation  : 4 × uint8   = 4B   (normalized quat remapped 0..255)

    We also: drop non-finite rows, rotate 180° about X (Y-down -> Y-up),
    optionally cap count by opacity, and sort by sigmoid(op) * prod(exp(scale))
    descending (gradio convention — bigger / more opaque first).
    """
    import numpy as np
    from plyfile import PlyData

    SH_C0 = 0.28209479177387814

    v = PlyData.read(str(src))["vertex"].data

    keep = (
        np.isfinite(v["x"]) & np.isfinite(v["y"]) & np.isfinite(v["z"]) &
        np.isfinite(v["scale_0"]) & np.isfinite(v["scale_1"]) & np.isfinite(v["scale_2"]) &
        np.isfinite(v["rot_0"]) & np.isfinite(v["rot_1"]) &
        np.isfinite(v["rot_2"]) & np.isfinite(v["rot_3"]) &
        np.isfinite(v["opacity"]) &
        np.isfinite(v["f_dc_0"]) & np.isfinite(v["f_dc_1"]) & np.isfinite(v["f_dc_2"])
    )
    if not keep.all():
        print(f"[splat_conv] dropped {int((~keep).sum())} non-finite gaussians")
        v = v[keep]

    # NOTE: WorldMirror's model applies sigmoid in `reg_dense_opacities` before
    # saving, so the `opacity` field is ALREADY activated — probability in
    # [0, 1], not a logit. Any downstream sigmoid (gradio's process_ply_to_splat
    # or @mkkellogg's PLY loader) would double-activate and squash everything to
    # [0.5, 0.73] = the "purple smear". We take opacity as probability here.
    opa = v["opacity"].astype(np.float64)
    scale_sum = np.exp(
        v["scale_0"].astype(np.float64) +
        v["scale_1"].astype(np.float64) +
        v["scale_2"].astype(np.float64)
    )
    score = -(scale_sum * opa)  # negative → argsort gives descending
    order = np.argsort(score, kind="stable")

    if max_splats is not None and len(order) > max_splats:
        print(f"[splat_conv] capping {len(order)} -> {max_splats}")
        order = order[:max_splats]

    n = len(order)
    out = np.empty(n * 32, dtype=np.uint8)
    buf32 = out.view(np.float32)

    for row, idx in enumerate(order):
        s = v[idx]
        b0 = row * 32
        f = b0 // 4
        # position (with 180° X rotation: y -> -y, z -> -z)
        buf32[f + 0] = float(s["x"])
        buf32[f + 1] = -float(s["y"])
        buf32[f + 2] = -float(s["z"])
        # scale (pre-exp)
        buf32[f + 3] = float(np.exp(s["scale_0"]))
        buf32[f + 4] = float(np.exp(s["scale_1"]))
        buf32[f + 5] = float(np.exp(s["scale_2"]))
        # color (uint8 RGBA). f_dc is SH DC coefficient; opacity is already
        # sigmoid-activated (see note above), so use it directly as alpha.
        r = 0.5 + SH_C0 * float(s["f_dc_0"])
        g = 0.5 + SH_C0 * float(s["f_dc_1"])
        bl = 0.5 + SH_C0 * float(s["f_dc_2"])
        a = float(s["opacity"])
        out[b0 + 24] = int(np.clip(r * 255.0, 0, 255))
        out[b0 + 25] = int(np.clip(g * 255.0, 0, 255))
        out[b0 + 26] = int(np.clip(bl * 255.0, 0, 255))
        out[b0 + 27] = int(np.clip(a * 255.0, 0, 255))
        # rotation: rotate by (0,1,0,0) quat (180° X), then normalize + quantize
        # (w, x, y, z) -> (-x, w, -z, y)
        qw, qx, qy, qz = float(s["rot_0"]), float(s["rot_1"]), float(s["rot_2"]), float(s["rot_3"])
        nw, nx, ny, nz = -qx, qw, -qz, qy
        norm = (nw * nw + nx * nx + ny * ny + nz * nz) ** 0.5 or 1.0
        out[b0 + 28] = int(np.clip(nw / norm * 128 + 128, 0, 255))
        out[b0 + 29] = int(np.clip(nx / norm * 128 + 128, 0, 255))
        out[b0 + 30] = int(np.clip(ny / norm * 128 + 128, 0, 255))
        out[b0 + 31] = int(np.clip(nz / norm * 128 + 128, 0, 255))

    dst.write_bytes(out.tobytes())
    return n


def _fix_worldmirror_splat_ply(src: Path, dst: Path, max_splats: int | None = None) -> int:
    """Transform WorldMirror's gaussians.ply for @mkkellogg/gaussian-splats-3d.

    Mismatches vs. the INRIA 3DGS convention that we normalize here:
      1. Opacity is saved already-sigmoided; the viewer applies sigmoid again
         → invert it here so the viewer's sigmoid recovers the original.
      2. World frame is Y-down (vision convention); rotate 180° around X so the
         scene stands upright in a standard Y-up viewer.
      3. Drop gaussians with non-finite fields (rare but seen with video inputs
         where some frames yield bad depth).
      4. Optionally cap total splat count (keep highest-opacity) to stay inside
         the browser splat sorter's memory envelope.

    Returns the final splat count written.
    """
    import numpy as np  # local: avoid import cost at startup
    from plyfile import PlyData, PlyElement

    ply = PlyData.read(str(src))
    v = ply["vertex"].data.copy()

    # Drop non-finite rows first — NaN in means breaks the WASM radix sort.
    finite_mask = np.isfinite(v["x"]) & np.isfinite(v["y"]) & np.isfinite(v["z"]) \
        & np.isfinite(v["scale_0"]) & np.isfinite(v["scale_1"]) & np.isfinite(v["scale_2"]) \
        & np.isfinite(v["rot_0"]) & np.isfinite(v["rot_1"]) \
        & np.isfinite(v["rot_2"]) & np.isfinite(v["rot_3"]) \
        & np.isfinite(v["opacity"])
    if not finite_mask.all():
        dropped = int((~finite_mask).sum())
        print(f"[splat_fix] dropped {dropped} non-finite gaussians")
        v = v[finite_mask]

    # Cap splat count by keeping the highest-opacity gaussians.
    if max_splats is not None and len(v) > max_splats:
        print(f"[splat_fix] downsampling {len(v)} -> {max_splats} by opacity")
        order = np.argsort(-v["opacity"])[:max_splats]
        order.sort()  # keep original order for locality
        v = v[order]

    # 180° rotation around X: (x, y, z) -> (x, -y, -z)
    v["y"] = -v["y"]
    v["z"] = -v["z"]

    # Rotate the per-gaussian quaternion by q_rot = (w=0, x=1, y=0, z=0).
    # Left-multiply: (w, x, y, z) -> (-x, w, -z, y)
    r0 = v["rot_0"].copy()  # w
    r1 = v["rot_1"].copy()  # x
    r2 = v["rot_2"].copy()  # y
    r3 = v["rot_3"].copy()  # z
    v["rot_0"] = -r1
    v["rot_1"] = r0
    v["rot_2"] = -r3
    v["rot_3"] = r2

    # Inverse-sigmoid opacity so the viewer's sigmoid recovers WorldMirror's value
    op = np.clip(v["opacity"].astype(np.float32), 1e-6, 1.0 - 1e-6)
    v["opacity"] = np.log(op / (1.0 - op)).astype(np.float32)

    out = PlyData([PlyElement.describe(v, "vertex")])
    out.write(str(dst))
    return len(v)


# Default cap well under what the WASM sort worker has misbehaved at in practice.
# Overridable per-request via ?max_splats=N; 0 disables the cap.
DEFAULT_VIEWER_SPLAT_CAP = 1_200_000


def _resolve_splat_cap(max_splats: int | None) -> int | None:
    if max_splats is None:
        return DEFAULT_VIEWER_SPLAT_CAP
    if max_splats <= 0:
        return None
    return max_splats


@app.get("/api/jobs/{job_id}/gaussians.splat")
def get_job_gaussians_splat(job_id: str, max_splats: int | None = None):
    """Viewer-ready antimatter15 `.splat` binary (pre-activated values, Y-up).

    This is what we actually serve to the browser viewer — no sigmoid/SH math
    for the client to get wrong, and 4x smaller than the PLY.
    """
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if job is None or not job.output_dir:
        raise HTTPException(404, "job not found")
    root = Path(job.output_dir)
    src = root / "gaussians.ply"
    if not src.is_file():
        raise HTTPException(404, "gaussians.ply not produced")
    cap = _resolve_splat_cap(max_splats)
    suffix = f"_cap{cap}" if cap else "_full"
    dst = root / f"gaussians_view{suffix}.splat"
    if not dst.is_file() or dst.stat().st_mtime < src.stat().st_mtime:
        _worldmirror_ply_to_splat(src, dst, max_splats=cap)
    return FileResponse(dst, media_type="application/octet-stream")


# Kept for debugging / power users who want the transformed PLY directly.
@app.get("/api/jobs/{job_id}/splat")
def get_job_splat(job_id: str, max_splats: int | None = None):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if job is None or not job.output_dir:
        raise HTTPException(404, "job not found")
    root = Path(job.output_dir)
    src = root / "gaussians.ply"
    if not src.is_file():
        raise HTTPException(404, "gaussians.ply not produced")
    cap = _resolve_splat_cap(max_splats)
    suffix = f"_cap{cap}" if cap else "_full"
    dst = root / f"gaussians_view{suffix}.ply"
    if not dst.is_file() or dst.stat().st_mtime < src.stat().st_mtime:
        _fix_worldmirror_splat_ply(src, dst, max_splats=cap)
    return FileResponse(dst, media_type="application/octet-stream")


@app.get("/api/jobs/{job_id}/file/{path:path}")
def get_job_file(job_id: str, path: str):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if job is None or not job.output_dir:
        raise HTTPException(404, "job not found")
    root = Path(job.output_dir).resolve()
    target = (root / path).resolve()
    if root not in target.parents and target != root:
        raise HTTPException(400, "invalid path")
    if not target.is_file():
        raise HTTPException(404, "file not found")
    return FileResponse(target)


@app.get("/api/jobs/{job_id}/bundle")
def get_job_bundle(job_id: str):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if job is None or not job.output_dir:
        raise HTTPException(404, "job not found")
    root = Path(job.output_dir)
    if not root.exists():
        raise HTTPException(404, "no output")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in root.rglob("*"):
            if p.is_file():
                zf.write(p, p.relative_to(root).as_posix())
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="hyworld-{job_id}.zip"'},
    )


@app.post("/api/pipeline/warmup")
def warmup() -> dict[str, Any]:
    """Eagerly load the model so first inference is faster."""
    def _load():
        try:
            HOLDER.get()
        except Exception:
            pass
    threading.Thread(target=_load, daemon=True).start()
    return HOLDER.status()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
