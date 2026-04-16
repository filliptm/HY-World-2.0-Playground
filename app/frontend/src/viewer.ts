import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";

// ---------------------------------------------------------------------------
// Camera frustum overlay
// ---------------------------------------------------------------------------
interface CameraParams {
  num_cameras: number;
  extrinsics: { camera_id: number; matrix: number[][] }[];
  intrinsics: { camera_id: number; matrix: number[][] }[];
}

/** Build a wireframe frustum for one (c2w, K) pair in the rotated Y-up frame. */
function buildFrustum(
  c2w: number[][],
  K: number[][],
  depth: number,
  color: number,
): THREE.LineSegments {
  const fx = K[0][0], fy = K[1][1], cx = K[0][2], cy = K[1][2];
  const halfW = (depth * cx) / fx;
  const halfH = (depth * cy) / fy;

  // OpenCV convention: +Z is forward (into the scene from the camera).
  const pts: number[][] = [
    [0, 0, 0],                  // 0: apex
    [-halfW, -halfH, depth],    // 1: top-left of image plane at z=depth
    [ halfW, -halfH, depth],    // 2: top-right
    [ halfW,  halfH, depth],    // 3: bottom-right
    [-halfW,  halfH, depth],    // 4: bottom-left
    [0, -halfH * 1.4, depth * 1.1], // 5: small notch showing "up"
  ];
  const edges: [number, number][] = [
    [0, 1], [0, 2], [0, 3], [0, 4], // apex -> corners
    [1, 2], [2, 3], [3, 4], [4, 1], // image-plane rectangle
    [1, 5], [2, 5],                 // little up-pointing triangle
  ];

  const positions: number[] = [];
  for (const [a, b] of edges) positions.push(...pts[a], ...pts[b]);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));

  // c2w is 4x4 row-major from JSON; three.js Matrix4 takes column-major array.
  const m = new THREE.Matrix4().fromArray([
    c2w[0][0], c2w[1][0], c2w[2][0], c2w[3][0],
    c2w[0][1], c2w[1][1], c2w[2][1], c2w[3][1],
    c2w[0][2], c2w[1][2], c2w[2][2], c2w[3][2],
    c2w[0][3], c2w[1][3], c2w[2][3], c2w[3][3],
  ]);
  // Match the 180° X rotation we baked into the splat: (x,y,z) -> (x,-y,-z).
  const worldFlip = new THREE.Matrix4().makeScale(1, -1, -1);
  m.premultiply(worldFlip);

  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 });
  const lines = new THREE.LineSegments(geom, mat);
  lines.applyMatrix4(m);
  return lines;
}

/** Build a THREE.Group containing one frustum per camera. */
export async function buildFrustumOverlay(
  cameraParamsUrl: string,
  opts: { depth?: number; color?: number } = {},
): Promise<THREE.Group> {
  const res = await fetch(cameraParamsUrl);
  const data: CameraParams = await res.json();
  const depth = opts.depth ?? 0.15;
  const color = opts.color ?? 0xffb750;
  const group = new THREE.Group();
  group.name = "cameraFrustums";

  // Index intrinsics by camera_id
  const kByCam = new Map<number, number[][]>();
  for (const k of data.intrinsics) kByCam.set(k.camera_id, k.matrix);

  for (const e of data.extrinsics) {
    const k = kByCam.get(e.camera_id);
    if (!k) continue;
    group.add(buildFrustum(e.matrix, k, depth, color));
  }
  return group;
}

// 3DGS viewer (mkkellogg): dynamic import so failures don't break the rest
let splatModPromise: Promise<any> | null = null;
function loadSplatMod() {
  if (!splatModPromise) {
    splatModPromise = import("@mkkellogg/gaussian-splats-3d");
  }
  return splatModPromise;
}

export class SplatViewer {
  private container: HTMLElement;
  private viewer: any = null;
  private disposed = false;
  private loadSeq = 0;
  private frustumGroup: THREE.Group | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  async load(plyUrl: string): Promise<void> {
    const mySeq = ++this.loadSeq;
    await this.dispose();
    if (mySeq !== this.loadSeq) return; // superseded by a newer load
    this.disposed = false;

    const mod = await loadSplatMod();
    const GaussianSplats3D = mod.default ?? mod;

    const viewer = new GaussianSplats3D.Viewer({
      rootElement: this.container,
      cameraUp: [0, 1, 0],
      initialCameraPosition: [0, 0, 5],
      initialCameraLookAt: [0, 0, 0],
      sphericalHarmonicsDegree: 0,
      sharedMemoryForWorkers: false,
      useBuiltInControls: true,
      antialiased: true,
      selfDrivenMode: true,
      // Smaller distance-map precision = smaller WASM sort buffers; helps
      // avoid the OOB we saw on some ~1.6M-splat video scenes.
      splatSortDistanceMapPrecision: 14,
    });
    this.viewer = viewer;

    try {
      // URL ends in .splat → viewer auto-detects SceneFormat.Splat and reads
      // our pre-activated binary without any SH/sigmoid interpretation.
      await viewer.addSplatScene(plyUrl, {
        splatAlphaRemovalThreshold: 1,
        showLoadingUI: true,
      });
    } catch (e) {
      // Scene add can throw NotFoundError mid-teardown if a previous dispose
      // raced with us. Swallow when we're no longer the active load.
      if (mySeq !== this.loadSeq || this.disposed) return;
      throw e;
    }

    if (mySeq !== this.loadSeq || this.disposed) {
      await this.dispose();
      return;
    }
    viewer.start();
  }

  /** Add camera frustum overlay. `show` toggles visibility. */
  async showFrustums(cameraParamsUrl: string, show: boolean): Promise<void> {
    if (!this.viewer) return;
    // Clear any previous group first
    if (this.frustumGroup) {
      this.viewer.threeScene?.remove(this.frustumGroup);
      this.frustumGroup.traverse((o: any) => {
        o.geometry?.dispose?.();
        o.material?.dispose?.();
      });
      this.frustumGroup = null;
    }
    if (!show) return;
    try {
      const group = await buildFrustumOverlay(cameraParamsUrl);
      this.frustumGroup = group;
      this.viewer.threeScene?.add(group);
    } catch (e) {
      console.warn("[frustums] failed:", e);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const v = this.viewer;
    this.viewer = null;
    // Drop frustum group so it doesn't leak across loads.
    if (this.frustumGroup) {
      this.frustumGroup.traverse((o: any) => {
        o.geometry?.dispose?.();
        o.material?.dispose?.();
      });
      this.frustumGroup = null;
    }
    if (v) {
      // @mkkellogg's dispose() is async; if we don't await it, the next load()
      // clears the DOM while teardown is still in flight → removeChild throws.
      try {
        const p = v.dispose();
        if (p && typeof p.then === "function") {
          await p.catch(() => { /* swallow teardown races */ });
        }
      } catch { /* noop */ }
    }
    // Safely clear any stragglers — children may already be gone.
    while (this.container.firstChild) {
      try { this.container.removeChild(this.container.firstChild); }
      catch { break; }
    }
  }
}

export class PointCloudViewer {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private controls: OrbitControls | null = null;
  private raf = 0;
  private disposed = false;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  private ensureScene(): void {
    if (this.renderer) return;
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 600;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(0x0b0d10);
    this.container.innerHTML = "";
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.01, 1000);
    this.camera.position.set(0, 0, 3);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(this.container);

    const tick = () => {
      if (this.disposed) return;
      this.controls?.update();
      if (this.scene && this.camera && this.renderer) {
        this.renderer.render(this.scene, this.camera);
      }
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  private resize(): void {
    if (!this.renderer || !this.camera) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  async load(plyUrl: string): Promise<void> {
    this.disposed = false;
    this.ensureScene();
    if (!this.scene) return;

    while (this.scene.children.length) this.scene.remove(this.scene.children[0]);

    const loader = new PLYLoader();
    const geom = await loader.loadAsync(plyUrl);
    // WorldMirror world frame is Y-down; rotate 180° around X so up is +Y.
    geom.rotateX(Math.PI);
    geom.computeBoundingBox();
    const box = geom.boundingBox!;
    const center = new THREE.Vector3();
    box.getCenter(center);
    geom.translate(-center.x, -center.y, -center.z);

    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;

    const hasColor = !!geom.getAttribute("color");
    const mat = new THREE.PointsMaterial({
      size: maxDim * 0.0015,
      vertexColors: hasColor,
      color: hasColor ? 0xffffff : 0x9ecbff,
      sizeAttenuation: true,
    });

    const points = new THREE.Points(geom, mat);
    this.scene.add(points);

    if (this.camera && this.controls) {
      this.camera.position.set(0, 0, maxDim * 1.6);
      this.controls.target.set(0, 0, 0);
      this.controls.update();
    }
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.domElement.remove();
      this.renderer = null;
    }
    this.scene = null;
    this.camera = null;
    this.controls = null;
  }
}
