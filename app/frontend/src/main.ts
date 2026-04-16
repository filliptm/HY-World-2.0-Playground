import {
  Example,
  fileUrl,
  getHealth,
  getJob,
  Job,
  listExamples,
  listJobs,
  runExample,
  runUpload,
  warmup,
} from "./api";
import { hydrateIcons, Icons } from "./icons";
import { PointCloudViewer, SplatViewer } from "./viewer";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const $$ = <T extends HTMLElement>(sel: string) => Array.from(document.querySelectorAll<T>(sel));

type InputMode = "example" | "upload";
let inputMode: InputMode = "example";
let examplesCache: Example[] = [];
let selectedExampleId: string | null = null;
let uploadedFiles: File[] = [];
let currentJobId: string | null = null;
let pollTimer: number | null = null;

let splatViewer: SplatViewer;
let pointsViewer: PointCloudViewer;

// ---------- Health -------------------------------------------------------
async function refreshHealth() {
  const chip = $("#gpu-chip");
  const text = chip.querySelector<HTMLElement>(".gpu-text")!;
  try {
    const h = await getHealth();
    chip.classList.remove("ok", "busy", "err");
    if (h.pipeline.error) {
      chip.classList.add("err");
      text.textContent = "pipeline error";
      chip.title = h.pipeline.error;
    } else if (h.pipeline.loading) {
      chip.classList.add("busy");
      text.textContent = "loading model";
    } else if (h.pipeline.loaded) {
      chip.classList.add("ok");
      text.textContent = h.cuda ? "CUDA ready" : "CPU";
    } else {
      chip.classList.add(h.cuda ? "ok" : "err");
      text.textContent = h.cuda ? (h.device?.split(" ").slice(1, 4).join(" ") ?? "CUDA") : "no CUDA";
    }
  } catch (e) {
    chip.classList.remove("ok", "busy");
    chip.classList.add("err");
    text.textContent = "backend offline";
  }
}

// ---------- Examples grid ------------------------------------------------
async function loadExamples() {
  const grid = $("#example-grid");
  try {
    examplesCache = await listExamples();
  } catch (e) {
    log(`listExamples failed: ${(e as Error).message}`);
    examplesCache = [];
    grid.innerHTML = `<div class='example-grid-empty'>Couldn't load examples</div>`;
    return;
  }
  renderExamples();
  // Auto-select first example
  if (examplesCache.length && !selectedExampleId) {
    selectedExampleId = examplesCache[0].id;
    renderExamples();
  }
}

function renderExamples(filter = "") {
  const grid = $("#example-grid");
  grid.innerHTML = "";
  const q = filter.trim().toLowerCase();
  const filtered = examplesCache.filter(
    e => !q || e.name.toLowerCase().includes(q) || e.category.toLowerCase().includes(q),
  );
  if (filtered.length === 0) {
    grid.innerHTML = `<div class='example-grid-empty'>No matches</div>`;
    return;
  }
  // Group by category
  const groups = new Map<string, Example[]>();
  for (const ex of filtered) {
    const arr = groups.get(ex.category) ?? [];
    arr.push(ex);
    groups.set(ex.category, arr);
  }
  for (const [cat, items] of groups) {
    const header = document.createElement("div");
    header.className = "example-grid-group";
    header.textContent = cat;
    grid.appendChild(header);
    for (const ex of items) {
      const card = document.createElement("div");
      card.className = "example-card" + (ex.id === selectedExampleId ? " selected" : "");
      card.innerHTML = `
        <img class="thumb" src="${ex.thumbnail}" alt="${ex.name}" loading="lazy" />
        <div class="card-meta">
          <span class="card-name" title="${ex.name}">${ex.name}</span>
          <span class="card-count">${ex.image_count}</span>
        </div>
        <span class="card-check">${Icons.check}</span>
      `;
      card.addEventListener("click", () => {
        selectedExampleId = ex.id;
        renderExamples(filter);
      });
      grid.appendChild(card);
    }
  }
}

function currentExample(): Example | undefined {
  return examplesCache.find(e => e.id === selectedExampleId);
}

// ---------- Upload -------------------------------------------------------
function initDropZone() {
  const zone = $<HTMLLabelElement>("#drop-zone");
  const input = $<HTMLInputElement>("#upload-files");

  const accept = (files: FileList | File[] | null) => {
    if (!files) return;
    uploadedFiles = Array.from(files);
    renderUploadPreview();
  };

  input.addEventListener("change", () => accept(input.files));

  ["dragenter", "dragover"].forEach(evt =>
    zone.addEventListener(evt, e => {
      e.preventDefault();
      zone.classList.add("drag-over");
    }),
  );
  ["dragleave", "drop"].forEach(evt =>
    zone.addEventListener(evt, e => {
      e.preventDefault();
      zone.classList.remove("drag-over");
    }),
  );
  zone.addEventListener("drop", e => {
    e.preventDefault();
    const dt = (e as DragEvent).dataTransfer;
    if (dt?.files?.length) {
      input.files = dt.files;
      accept(dt.files);
    }
  });
}

function renderUploadPreview() {
  const wrap = $("#upload-preview");
  wrap.innerHTML = "";
  for (const f of uploadedFiles.slice(0, 20)) {
    const tile = document.createElement("div");
    tile.className = "upload-tile";
    const isImg = f.type.startsWith("image/");
    const thumb = isImg
      ? `<img src="${URL.createObjectURL(f)}" />`
      : `<span style="color: var(--fg-mute); display:flex;">${Icons.film}</span>`;
    tile.innerHTML = `
      ${thumb}
      <span class="name" title="${f.name}">${f.name}</span>
      <span class="size">${humanBytes(f.size)}</span>
    `;
    wrap.appendChild(tile);
  }
  if (uploadedFiles.length > 20) {
    const more = document.createElement("div");
    more.className = "upload-tile";
    more.style.color = "var(--fg-mute)";
    more.textContent = `+${uploadedFiles.length - 20} more`;
    wrap.appendChild(more);
  }
}

// ---------- Input mode tabs ---------------------------------------------
function bindInputTabs() {
  $$(".seg").forEach(btn => {
    btn.addEventListener("click", () => {
      $$(".seg").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      inputMode = btn.dataset.tab as InputMode;
      $$(".tab-body").forEach(b => {
        b.classList.toggle("hidden", b.dataset.body !== inputMode);
      });
    });
  });
}

// ---------- View tabs ----------------------------------------------------
function bindViewTabs() {
  $$(".view-tab").forEach(btn => {
    btn.addEventListener("click", () => switchView(btn.dataset.view!));
  });
}
function switchView(view: string) {
  $$(".view-tab").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  $$(".view").forEach(v => v.classList.toggle("hidden", v.id !== `view-${view}`));
}

// ---------- Drawer -------------------------------------------------------
function bindDrawer() {
  const drawer = $("#drawer");
  const toggle = $("#drawer-toggle");

  const setOpen = (open: boolean) => drawer.setAttribute("data-open", String(open));

  toggle.addEventListener("click", () => {
    setOpen(drawer.getAttribute("data-open") !== "true");
  });

  $$(".drawer-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      $$(".drawer-tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const name = btn.dataset.drawer!;
      $$(".drawer-pane").forEach(p => p.classList.toggle("active", p.dataset.pane === name));
      // Opening a tab also expands the drawer
      setOpen(true);
    });
  });
}

// ---------- Params collection ------------------------------------------
const BOOL_KEYS = new Set([
  "save_depth", "save_normal", "save_gs", "save_camera", "save_points",
  "save_colmap", "save_conf", "apply_sky_mask", "apply_edge_mask",
  "apply_confidence_mask", "save_sky_mask", "compress_pts",
  "save_rendered", "render_depth",
]);
const INT_KEYS = new Set([
  "target_size", "fps", "video_min_frames", "video_max_frames",
  "compress_pts_max_points", "max_resolution", "compress_gs_max_points",
  "render_interp_per_pair",
]);
const FLOAT_KEYS = new Set([
  "model_sky_threshold", "confidence_percentile",
  "edge_normal_threshold", "edge_depth_threshold", "compress_pts_voxel_size",
]);

function collectParams(): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const inputs = $$<HTMLInputElement | HTMLSelectElement>(
    ".sidebar input[name], .sidebar select[name]",
  );
  for (const el of inputs) {
    const name = el.name;
    if (!name) continue;
    if (el instanceof HTMLInputElement && el.type === "checkbox") {
      params[name] = el.checked;
    } else if (BOOL_KEYS.has(name)) {
      params[name] = (el as HTMLInputElement).checked;
    } else if (INT_KEYS.has(name)) {
      const v = parseInt(el.value, 10);
      if (!Number.isNaN(v)) params[name] = v;
    } else if (FLOAT_KEYS.has(name)) {
      const v = parseFloat(el.value);
      if (!Number.isNaN(v)) params[name] = v;
    } else {
      params[name] = el.value;
    }
  }
  return params;
}

// ---------- Status chips ------------------------------------------------
interface Chip { label: string; value: string; icon?: string; }
function renderChips(chips: Chip[]) {
  const wrap = $("#job-stats");
  wrap.innerHTML = "";
  for (const c of chips) {
    const el = document.createElement("span");
    el.className = "chip";
    el.innerHTML = `
      ${c.icon ? c.icon : ""}
      <span class="chip-label">${c.label}</span>
      <span class="chip-value">${c.value}</span>
    `;
    wrap.appendChild(el);
  }
}

function jobChips(job: Job | null): Chip[] {
  if (!job) return [];
  const chips: Chip[] = [];
  const elapsed = job.started_at
    ? ((job.finished_at ?? Date.now() / 1000) - job.started_at)
    : 0;
  chips.push({ label: "elapsed", value: `${elapsed.toFixed(1)}s`, icon: Icons.clock });

  if (job.frame_count != null) {
    chips.push({ label: "frames", value: String(job.frame_count), icon: Icons.film });
  }

  if (job.splat_count != null) {
    chips.push({ label: "splats", value: compactNumber(job.splat_count), icon: Icons.splat });
  } else {
    // fallback when backend didn't pre-compute (old jobs that predate field)
    const gs = (job.files ?? []).find(f => f.name === "gaussians.ply");
    if (gs) chips.push({ label: "splats", value: "~" + compactNumber(Math.round(gs.size / 68)), icon: Icons.splat });
  }

  const points = (job.files ?? []).find(f => f.name === "points.ply");
  if (points) {
    const approx = Math.round(points.size / 15);
    chips.push({ label: "points", value: compactNumber(approx), icon: Icons.points });
  }

  const total = (job.files ?? []).reduce((sum, f) => sum + f.size, 0);
  if (total > 0) chips.push({ label: "output", value: humanBytes(total), icon: Icons.folder });

  return chips;
}

function compactNumber(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

// ---------- Status / polling ------------------------------------------
let viewingJob: Job | null = null;

function setStatus(job: Job | null) {
  viewingJob = job;
  const pill = $("#job-status");
  const idEl = $("#job-id");
  const dl = $<HTMLAnchorElement>("#job-download");
  const rerun = $<HTMLButtonElement>("#btn-rerun");

  const status = job?.status ?? "idle";
  pill.className = `status-pill ${status}`;
  const pillText = job?.status === "running" && job.message
    ? job.message
    : status;
  pill.querySelector<HTMLElement>(".pill-text")!.textContent = pillText;

  // Label between pill and chips: job id + source label
  if (job) {
    const src = job.source_label ? ` · ${job.source_label}` : "";
    idEl.textContent = `#${job.id}${src}`;
    updateTabTitle(job);
  } else {
    idEl.textContent = "";
    document.title = "HY-World 2.0 · WorldMirror Playground";
  }

  renderChips(jobChips(job));

  if (job && job.status === "done" && job.files.length > 0) {
    dl.hidden = false;
    dl.href = `/api/jobs/${job.id}/bundle`;
    rerun.hidden = false;
  } else {
    dl.hidden = true;
    rerun.hidden = true;
  }

  // files tab badge
  const fc = $("#files-count");
  fc.textContent = job?.files?.length ? String(job.files.length) : "";
}

function updateTabTitle(job: Job) {
  const emoji =
    job.status === "running" ? "⏳" :
    job.status === "done"    ? "✓"  :
    job.status === "error"   ? "✗"  : "";
  const label = job.source_label ?? job.id;
  document.title = `${emoji} ${job.status.toUpperCase()} · ${label} · HY-World 2.0`;
}

async function poll(jobId: string) {
  try {
    const job = await getJob(jobId);
    setStatus(job);
    if (job.status === "done") {
      log(`[done] job ${job.id} — ${job.files.length} files in ${((job.finished_at ?? 0) - (job.started_at ?? 0)).toFixed(1)}s`);
      await handleDone(job);
      refreshHistory();
      return;
    }
    if (job.status === "error") {
      log(`[error] ${job.error}`);
      openDrawer("log");
      refreshHistory();
      return;
    }
  } catch (e) {
    log(`[poll] error: ${(e as Error).message}`);
  }
  pollTimer = window.setTimeout(() => poll(jobId), 1200);
}

function openDrawer(pane: string) {
  $("#drawer").setAttribute("data-open", "true");
  $$(".drawer-tab").forEach(b => b.classList.toggle("active", b.dataset.drawer === pane));
  $$(".drawer-pane").forEach(p => p.classList.toggle("active", p.dataset.pane === pane));
}

async function handleDone(job: Job) {
  populateFiles(job);
  populateDepth(job);
  populateNormal(job);
  populateCameras(job);
  populateVideo(job);
  await populateSplat(job);
  await populatePoints(job);
}

function populateFiles(job: Job) {
  const list = $("#files-list");
  list.innerHTML = "";
  if (job.files.length === 0) {
    list.innerHTML = "<li><span class='muted'>No files</span></li>";
    return;
  }
  for (const f of job.files) {
    const li = document.createElement("li");
    li.innerHTML = `
      <a href="${fileUrl(job.id, f.name)}" target="_blank" rel="noopener">${f.name}</a>
      <span class="size">${humanBytes(f.size)}</span>
      <a href="${fileUrl(job.id, f.name)}" download="${f.name.split("/").pop()}" class="btn icon ghost small">${Icons.download}</a>
    `;
    list.appendChild(li);
  }
}

// ---------- Inspector modal --------------------------------------------
interface InspectorEntry { index: number; source: string; output: string; outputName: string; }
let inspectorItems: InspectorEntry[] = [];
let inspectorIndex = 0;
let inspectorKind = "";

function bindInspector() {
  const modal = $("#inspector");
  modal.querySelectorAll<HTMLElement>("[data-close]").forEach(b =>
    b.addEventListener("click", closeInspector),
  );
  $("#inspector-prev").addEventListener("click", () => stepInspector(-1));
  $("#inspector-next").addEventListener("click", () => stepInspector(1));
  document.addEventListener("keydown", e => {
    if (modal.hasAttribute("hidden")) return;
    if (e.key === "Escape") closeInspector();
    else if (e.key === "ArrowLeft") stepInspector(-1);
    else if (e.key === "ArrowRight") stepInspector(1);
  });
}

function openInspector(kind: "depth" | "normal", job: Job, entries: InspectorEntry[], index: number) {
  inspectorKind = kind;
  inspectorItems = entries;
  inspectorIndex = index;
  $("#inspector").removeAttribute("hidden");
  renderInspector();
}
function closeInspector() {
  $("#inspector").setAttribute("hidden", "");
}
function stepInspector(delta: number) {
  if (inspectorItems.length === 0) return;
  inspectorIndex = (inspectorIndex + delta + inspectorItems.length) % inspectorItems.length;
  renderInspector();
}
function renderInspector() {
  const entry = inspectorItems[inspectorIndex];
  if (!entry) return;
  $("#inspector-title").textContent = `${inspectorKind} · ${entry.outputName}  (${inspectorIndex + 1}/${inspectorItems.length})`;
  $<HTMLImageElement>("#inspector-source").src = entry.source;
  $<HTMLImageElement>("#inspector-output").src = entry.output;
  $("#inspector-output-caption").textContent = entry.outputName;
  $<HTMLAnchorElement>("#inspector-download").href = entry.output;
}

// ---------- Depth / normal ---------------------------------------------
function populateDepth(job: Job)  { populateImageKind(job, "depth", $("#depth-grid")); }
function populateNormal(job: Job) { populateImageKind(job, "normal", $("#normal-grid")); }

function populateImageKind(job: Job, kind: "depth" | "normal", grid: HTMLElement) {
  grid.innerHTML = "";
  const imgs = job.files.filter(f => f.name.startsWith(`${kind}/`) && f.suffix === ".png");
  if (imgs.length === 0) {
    grid.innerHTML = `<div class='image-grid-empty'>No ${kind} maps produced — enable "${kind === "depth" ? "Depth maps" : "Surface normals"}" in Outputs.</div>`;
    return;
  }
  // Backend saves the real input frames to job_dir/frames/ — use those as
  // the "source" column in the inspector. Fall back to the output image
  // if that copy didn't happen (older jobs).
  const sourceFrames = job.files
    .filter(f => f.name.startsWith("frames/") && /\.(png|jpg|jpeg|webp)$/i.test(f.name))
    .map(f => f.name)
    .sort();

  const entries: InspectorEntry[] = imgs.map((f, i) => ({
    index: i,
    source: sourceFrames[i] ? fileUrl(job.id, sourceFrames[i]) : fileUrl(job.id, f.name),
    output: fileUrl(job.id, f.name),
    outputName: f.name,
  }));

  for (let i = 0; i < imgs.length; i++) {
    const f = imgs[i];
    const fig = document.createElement("figure");
    fig.innerHTML = `
      <img src="${fileUrl(job.id, f.name)}" loading="lazy" />
      <figcaption>${f.name.split("/").pop()}</figcaption>
    `;
    fig.addEventListener("click", () => openInspector(kind, job, entries, i));
    grid.appendChild(fig);
  }
}

async function populateCameras(job: Job) {
  const pre = $("#cameras-json");
  const cam = job.files.find(f => f.name.endsWith("camera_params.json"));
  if (!cam) { pre.textContent = "(no camera_params.json)"; return; }
  try {
    const r = await fetch(fileUrl(job.id, cam.name));
    const json = await r.json();
    pre.textContent = JSON.stringify(json, null, 2);
  } catch (e) {
    pre.textContent = `failed: ${(e as Error).message}`;
  }
}

function populateVideo(job: Job) {
  const vid = $<HTMLVideoElement>("#rendered-video");
  const note = $("#video-note");
  const rendered = job.files.find(
    f => f.name.startsWith("rendered/") && (f.suffix === ".mp4" || f.suffix === ".webm"),
  );
  if (rendered) {
    vid.src = fileUrl(job.id, rendered.name);
    vid.style.display = "";
    note.textContent = rendered.name;
  } else {
    vid.removeAttribute("src");
    vid.style.display = "none";
    note.textContent = 'No rendered video — enable "Render fly-through video" to produce one.';
  }
}

async function populateSplat(job: Job) {
  const gs = job.files.find(f => f.name === "gaussians.ply");
  if (!gs) {
    $("#splat-canvas").innerHTML = "<p class='muted' style='padding:14px'>No gaussians.ply produced.</p>";
    return;
  }
  try {
    await splatViewer.load(`/api/jobs/${job.id}/gaussians.splat`);
    log(`[splat] loaded`);
    // Re-apply frustum toggle state for this job's cameras.
    const wantFrustums = $<HTMLInputElement>("#toggle-frustums").checked;
    const camFile = job.files.find(f => f.name === "camera_params.json");
    if (wantFrustums && camFile) {
      await splatViewer.showFrustums(fileUrl(job.id, "camera_params.json"), true);
    }
  } catch (e) {
    log(`[splat] load failed: ${(e as Error).message}`);
  }
}

async function populatePoints(job: Job) {
  const pts = job.files.find(f => f.name === "points.ply");
  if (!pts) {
    $("#points-canvas").innerHTML = "<p class='muted' style='padding:14px'>No points.ply produced.</p>";
    return;
  }
  try {
    await pointsViewer.load(fileUrl(job.id, pts.name));
  } catch (e) {
    log(`[points] load failed: ${(e as Error).message}`);
  }
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function log(msg: string) {
  const pre = $("#log-output");
  const now = new Date().toLocaleTimeString();
  pre.textContent += `[${now}] ${msg}\n`;
  pre.scrollTop = pre.scrollHeight;
}

// ---------- History ----------------------------------------------------
async function refreshHistory() {
  try {
    const jobs = await listJobs();
    renderHistory(jobs);
    const counter = $("#history-count");
    counter.textContent = jobs.length ? String(jobs.length) : "";
  } catch (e) {
    log(`history: ${(e as Error).message}`);
  }
}

function renderHistory(jobs: Job[]) {
  const list = $("#history-list");
  list.innerHTML = "";
  if (jobs.length === 0) {
    list.innerHTML = `<div class='history-empty'>No past runs yet. Run a scene to populate.</div>`;
    return;
  }
  for (const j of jobs) {
    const card = document.createElement("div");
    card.className = "history-card" + (j.id === currentJobId ? " current" : "");
    const elapsed = (j.started_at && j.finished_at) ? (j.finished_at - j.started_at) : 0;
    const when = new Date(j.created_at * 1000).toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
    const splats = j.splat_count != null ? compactNumber(j.splat_count) + " splats" : "";
    const frames = j.frame_count != null ? j.frame_count + "f" : "";
    const totalBytes = j.files.reduce((s, f) => s + f.size, 0);

    const thumb = j.thumbnail
      ? `<img class="hc-thumb" src="${j.thumbnail}" loading="lazy" />`
      : `<span class="hc-thumb-empty">${Icons.folder}</span>`;

    card.innerHTML = `
      ${thumb}
      <div class="hc-meta">
        <div>
          <div class="hc-title">${j.source_label ?? j.id}</div>
          <div class="hc-sub">#${j.id} · ${when}</div>
        </div>
        <div class="hc-stats">
          ${frames ? `<span><b>${frames}</b></span>` : ""}
          ${splats ? `<span>${splats}</span>` : ""}
          ${elapsed ? `<span>${elapsed.toFixed(1)}s</span>` : ""}
          <span>${humanBytes(totalBytes)}</span>
        </div>
      </div>
    `;
    card.addEventListener("click", () => loadJobIntoViews(j));
    list.appendChild(card);
  }
}

async function loadJobIntoViews(job: Job) {
  currentJobId = job.id;
  setStatus(job);
  await handleDone(job);
  // Highlight the now-current card.
  refreshHistory();
  log(`[history] loaded job ${job.id}`);
}

// ---------- Rerun ------------------------------------------------------
function applyParamsToForm(params: Record<string, unknown>) {
  const inputs = $$<HTMLInputElement | HTMLSelectElement>(
    ".sidebar input[name], .sidebar select[name]",
  );
  for (const el of inputs) {
    const v = params[el.name];
    if (v === undefined) continue;
    if (el instanceof HTMLInputElement && el.type === "checkbox") {
      el.checked = Boolean(v);
    } else {
      el.value = String(v);
    }
  }
}

async function onRerun() {
  if (!viewingJob) return;
  // Prefill form
  applyParamsToForm(viewingJob.params ?? {});
  // Set input mode & selection
  if (viewingJob.source_kind === "example" && viewingJob.source_ref) {
    switchInputMode("example");
    selectedExampleId = viewingJob.source_ref;
    renderExamples($<HTMLInputElement>("#example-search").value);
  } else if (viewingJob.source_kind === "upload") {
    switchInputMode("upload");
    log("[rerun] re-select files to run an upload again");
    // uploaded files aren't retained across page loads; user must pick again
  }
  // Kick it off (only if we have input; for upload the user must reselect)
  if (viewingJob.source_kind === "example") {
    await onRun();
  }
}

function switchInputMode(mode: "example" | "upload") {
  $$(".seg").forEach(b => b.classList.toggle("active", b.dataset.tab === mode));
  inputMode = mode;
  $$(".tab-body").forEach(b => b.classList.toggle("hidden", b.dataset.body !== mode));
}

// ---------- Run ---------------------------------------------------------
async function onRun() {
  const btn = $<HTMLButtonElement>("#btn-run");
  btn.disabled = true;
  try {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    const params = collectParams();
    log(`[run] params=${JSON.stringify(params)}`);
    let jobId: string;
    if (inputMode === "example") {
      const ex = currentExample();
      if (!ex) { log("no example selected"); return; }
      const [category, scene] = ex.id.split("/");
      const res = await runExample(category, scene, params);
      jobId = res.job_id;
    } else {
      if (uploadedFiles.length === 0) { log("no files selected"); return; }
      const res = await runUpload(uploadedFiles, params);
      jobId = res.job_id;
    }
    currentJobId = jobId;
    log(`[run] started job ${jobId}`);
    poll(jobId);
  } catch (e) {
    log(`[run] failed: ${(e as Error).message}`);
    openDrawer("log");
  } finally {
    btn.disabled = false;
  }
}

// Tick status bar every 250 ms while running so elapsed chip updates live.
let tickTimer: number | null = null;
function startTicker() {
  if (tickTimer) return;
  tickTimer = window.setInterval(async () => {
    if (!currentJobId) return;
    try {
      const job = await getJob(currentJobId);
      if (job.status === "running" || job.status === "queued") setStatus(job);
    } catch { /* ignore */ }
  }, 500);
}

// ---------- Bootstrap ---------------------------------------------------
async function main() {
  hydrateIcons();
  splatViewer = new SplatViewer($("#splat-canvas"));
  pointsViewer = new PointCloudViewer($("#points-canvas"));

  bindInputTabs();
  bindViewTabs();
  bindDrawer();
  bindInspector();
  initDropZone();

  $("#btn-run").addEventListener("click", onRun);
  $("#btn-rerun").addEventListener("click", onRerun);
  $<HTMLInputElement>("#toggle-frustums").addEventListener("change", async (e) => {
    const on = (e.target as HTMLInputElement).checked;
    if (!viewingJob) return;
    const camFile = viewingJob.files.find(f => f.name === "camera_params.json");
    if (!camFile) {
      log("[frustums] job has no camera_params.json");
      return;
    }
    await splatViewer.showFrustums(fileUrl(viewingJob.id, "camera_params.json"), on);
  });
  $("#btn-warmup").addEventListener("click", async () => {
    log("[warmup] triggered");
    await warmup();
    await refreshHealth();
  });
  $<HTMLInputElement>("#example-search").addEventListener("input", e => {
    renderExamples((e.target as HTMLInputElement).value);
  });

  await loadExamples();
  await refreshHealth();
  await refreshHistory();
  setStatus(null);
  startTicker();

  setInterval(refreshHealth, 5000);
}

main();
