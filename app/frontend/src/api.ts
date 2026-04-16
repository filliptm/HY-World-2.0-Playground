export interface Example {
  id: string;
  name: string;
  category: string;
  image_count: number;
  thumbnail: string;
  path: string;
}

export interface Health {
  ok: boolean;
  cuda: boolean;
  device: string | null;
  pipeline: { loaded: boolean; loading: boolean; error: string | null };
  examples_count: number;
}

export interface Job {
  id: string;
  status: "queued" | "running" | "done" | "error";
  progress: number;
  stage?: string;
  message: string;
  error: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  input_dir: string | null;
  output_dir: string | null;
  params: Record<string, unknown>;
  files: { name: string; size: number; suffix: string }[];
  source_kind?: "example" | "upload" | "unknown";
  source_ref?: string;
  source_label?: string;
  thumbnail?: string | null;
  splat_count?: number | null;
  frame_count?: number | null;
}

export async function listJobs(): Promise<Job[]> {
  const r = await fetch(`${BASE}/jobs`);
  if (!r.ok) throw new Error(`jobs ${r.status}`);
  return r.json();
}

const BASE = "/api";

export async function getHealth(): Promise<Health> {
  const r = await fetch(`${BASE}/health`);
  if (!r.ok) throw new Error(`health ${r.status}`);
  return r.json();
}

export async function listExamples(): Promise<Example[]> {
  const r = await fetch(`${BASE}/examples`);
  if (!r.ok) throw new Error(`examples ${r.status}`);
  return r.json();
}

export async function warmup(): Promise<unknown> {
  const r = await fetch(`${BASE}/pipeline/warmup`, { method: "POST" });
  return r.json();
}

export async function runExample(
  category: string,
  scene: string,
  params: Record<string, unknown>,
): Promise<{ job_id: string }> {
  const fd = new FormData();
  fd.append("category", category);
  fd.append("scene", scene);
  fd.append("params", JSON.stringify(params));
  const r = await fetch(`${BASE}/infer/example`, { method: "POST", body: fd });
  if (!r.ok) throw new Error(`infer ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function runUpload(
  files: File[],
  params: Record<string, unknown>,
): Promise<{ job_id: string }> {
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  fd.append("params", JSON.stringify(params));
  const r = await fetch(`${BASE}/infer/upload`, { method: "POST", body: fd });
  if (!r.ok) throw new Error(`infer ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function getJob(id: string): Promise<Job> {
  const r = await fetch(`${BASE}/jobs/${id}`);
  if (!r.ok) throw new Error(`job ${r.status}`);
  return r.json();
}

export function fileUrl(jobId: string, name: string): string {
  return `${BASE}/jobs/${jobId}/file/${encodeURI(name)}`;
}
