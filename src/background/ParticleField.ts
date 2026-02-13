import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

interface ParticleFieldOptions {
  canvas: HTMLCanvasElement;
}

interface ConstellationDef {
  stars: [number, number][];
  lines: [number, number][];
}

// Real constellation patterns (simplified coordinates)
const CONSTELLATION_DEFS: ConstellationDef[] = [
  // Orion
  {
    stars: [
      [1, 8], [4, 8],
      [1.5, 5.5], [2.5, 5.5], [3.5, 5.5],
      [0.5, 2], [4.5, 2],
      [2.5, 3.5],
    ],
    lines: [
      [0, 2], [1, 4],
      [2, 3], [3, 4],
      [2, 5], [4, 6],
      [3, 7],
    ],
  },
  // Big Dipper
  {
    stars: [
      [0, 0], [1.8, 0.4], [3.5, 0.2], [5, 1.2],
      [5.5, 3], [4, 3.8], [5.2, 4.5],
    ],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 3]],
  },
  // Cassiopeia — W shape
  {
    stars: [[0, 2], [1.5, 0], [3, 1.8], [4.5, 0], [6, 2]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4]],
  },
  // Cygnus — cross shape
  {
    stars: [
      [3, 0], [3, 2], [3, 4], [3, 6],
      [0.5, 3], [5.5, 3],
    ],
    lines: [[0, 1], [1, 2], [2, 3], [4, 2], [2, 5]],
  },
  // Scorpius — curved tail
  {
    stars: [
      [1, 5], [2, 4.5], [2.5, 3.5], [2.5, 2.5],
      [3, 1.5], [4, 1], [5, 1.5], [5.5, 2.5],
    ],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7]],
  },
  // Lyra — small diamond with tail
  {
    stars: [[2, 5], [1, 3], [3, 3], [1.5, 1.5], [2.5, 1.5]],
    lines: [[0, 1], [0, 2], [1, 3], [2, 4], [3, 4]],
  },
  // Gemini — two parallel lines
  {
    stars: [
      [0, 6], [0.5, 4], [1, 2], [1.5, 0],
      [3, 6], [2.5, 4], [2, 2], [1.8, 0.5],
    ],
    lines: [[0, 1], [1, 2], [2, 3], [4, 5], [5, 6], [6, 7], [0, 4], [2, 6]],
  },
];

const PATTERN_SPANS = CONSTELLATION_DEFS.map((def) => {
  let cx = 0;
  let cy = 0;
  for (const [sx, sy] of def.stars) {
    cx += sx;
    cy += sy;
  }
  cx /= def.stars.length;
  cy /= def.stars.length;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [sx, sy] of def.stars) {
    const x = sx - cx;
    const y = sy - cy;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Math.max(maxX - minX, maxY - minY, 1);
});
const AVG_PATTERN_SPAN =
  PATTERN_SPANS.reduce((sum, span) => sum + span, 0) / PATTERN_SPANS.length;
const PATTERN_STAR_COUNTS = CONSTELLATION_DEFS.map((def) => def.stars.length);
const AVG_PATTERN_STAR_COUNT =
  PATTERN_STAR_COUNTS.reduce((sum, count) => sum + count, 0) /
  PATTERN_STAR_COUNTS.length;

/* ---------- Dynamic constellation types ---------- */

const enum ConstellationState {
  Forming,
  Active,
  Fading,
  Dissolved,
}

interface LiveConstellation {
  patternIndex: number;
  state: ConstellationState;
  particleIndices: number[];
  lineSegments: THREE.LineSegments;
  lineGeometry: THREE.BufferGeometry;
  lineMaterial: THREE.LineBasicMaterial;
  anchorPositions: Float32Array;
  initialMaxDist: number;
  opacity: number;
  formStartTime: number;
  fadeStartTime: number;
  spreadRatio: number;
  baseColor: THREE.Color;
  starBoost: number;
  lineProgress: number[];
  lineFlashTimers: number[];
}

interface ScrollParallaxConfig {
  impulse: number;
  damping: number;
  yClamp: number;
  pitchClamp: number;
  deltaClamp: number;
}

interface PatternMatchResult {
  particleIndices: number[];
  score: number;
}

/* ---------- Tuning constants ---------- */

const CLUSTER_SEARCH_INTERVAL = 3.0;
const LINE_DRAW_DURATION = 0.5;
const LINE_STAGGER = 0.4;
const FLASH_DURATION = 0.3;
const FLASH_INTENSITY = 5.0;
const FADE_DURATION = 1.5;
const SPREAD_FADE_START = 1.8;
const SPREAD_DISSOLVE = 2.5;
const REPULSION_FORCE = 0.03;
const STAR_BOOST_MAX = 2.5;
const GRID_CELL_SIZE = 80;
const GRID_SIZE = 15;
const WRAP_DETECT_DIST = 400;
const SPAWN_SCREEN_PADDING = 0.18;
const DESPAWN_SCREEN_PADDING = 0.35;
const SCREEN_Z_PADDING = 0.2;
const MIN_ONSCREEN_LIFETIME = 1.5;
const MATCH_ANGLE_STEPS = 12;
const MATCH_POOL_MULTIPLIER = 3;
const MATCH_SCALE_VARIANTS = [0.7, 0.85, 1.0] as const;
const MATCH_QUALITY_THRESHOLD = 1.15;
const CLUSTER_BLOCK_TRY_COUNT = 18;
const ACTIVE_PATTERN_PENALTY = 0.08;
const PATTERN_COOLDOWN_SECONDS = 12.0;
const PATTERN_COOLDOWN_PENALTY = 0.14;
const PATTERN_SPAN_BIAS_POWER = 1.0;
const PATTERN_COMPLEXITY_BIAS_POWER = 0.5;
const MATCH_TOP_PATTERN_CHOICES = 4;
const MATCH_SELECTION_TEMPERATURE = 0.08;
const SCROLL_LERP = 0.12;
const SCROLL_DESKTOP_CONFIG: ScrollParallaxConfig = {
  impulse: 0.12,
  damping: 0.9,
  yClamp: 18,
  pitchClamp: 0.02,
  deltaClamp: 120,
};
const SCROLL_MOBILE_CONFIG: ScrollParallaxConfig = {
  impulse: 0.07,
  damping: 0.93,
  yClamp: 9,
  pitchClamp: 0.01,
  deltaClamp: 80,
};
const REDUCED_MOTION_SCALE = 0.5;

/* ---------- Color palette (cyan → purple cycle) ---------- */

const PALETTE_COLORS = [
  new THREE.Color(0.1, 1.0, 1.2),
  new THREE.Color(0.3, 0.8, 1.5),
  new THREE.Color(0.5, 0.5, 1.8),
  new THREE.Color(0.8, 0.3, 1.5),
  new THREE.Color(0.6, 0.3, 1.0),
  new THREE.Color(0.2, 1.2, 1.0),
  new THREE.Color(1.0, 0.4, 1.2),
];

export class ParticleField {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private particles!: THREE.Points;
  private particleCount: number;
  private particlePositions!: Float32Array;
  private particleVelocities!: Float32Array;
  private particlePhases!: Float32Array;
  private particleSpeeds!: Float32Array;
  private baseOpacities!: Float32Array;
  private colors!: Float32Array;
  private particleBoost!: Float32Array;
  private circleTexture!: THREE.Texture;
  private mouse = { x: 0, y: 0 };
  private targetMouse = { x: 0, y: 0 };
  private mouseScreen = { x: 0.5, y: 0.5 };
  private targetMouseScreen = { x: 0.5, y: 0.5 };
  private spotlightEl: HTMLElement | null;
  private rafId = 0;
  private disposed = false;
  private time = 0;

  /* Dynamic constellations */
  private liveConstellations: LiveConstellation[] = [];
  private usedParticleSet = new Set<number>();
  private lastClusterSearch = 0;
  private maxConstellations: number;
  private colorCycleIndex = 0;
  private scrollConfig: ScrollParallaxConfig = { ...SCROLL_DESKTOP_CONFIG };
  private scrollTargetYOffset = 0;
  private scrollCurrentYOffset = 0;
  private scrollTargetPitch = 0;
  private scrollCurrentPitch = 0;
  private lastScrollY = 0;
  private projectionTemp = new THREE.Vector3();
  private patternCooldownUntil = new Float32Array(CONSTELLATION_DEFS.length);

  constructor(options: ParticleFieldOptions) {
    const isMobile = window.innerWidth < 768;
    this.particleCount = isMobile
      ? 800
      : Math.min(this.getAdaptiveCount(), 5000);
    this.maxConstellations = isMobile ? 2 : 4;

    this.renderer = new THREE.WebGLRenderer({
      canvas: options.canvas,
      antialias: false,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      1,
      2000,
    );
    this.camera.position.z = 500;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      1.5,
      0.6,
      0.1,
    );
    this.composer.addPass(bloomPass);

    this.spotlightEl = document.getElementById("mouse-spotlight");
    this.circleTexture = this.createCircleTexture();
    this.lastScrollY = window.scrollY || window.pageYOffset || 0;
    this.updateScrollConfig();

    this.initParticles();
    this.bindEvents();
    this.animate();
  }

  private getAdaptiveCount(): number {
    try {
      const gl = this.renderer.getContext();
      const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
      if (debugInfo) {
        const gpu = gl.getParameter(
          debugInfo.UNMASKED_RENDERER_WEBGL,
        ) as string;
        if (/Intel|HD Graphics|UHD Graphics/i.test(gpu)) {
          return 4000;
        }
      }
    } catch {
      // Extension unavailable
    }
    return 10000;
  }

  private initParticles(): void {
    const count = this.particleCount;
    this.particlePositions = new Float32Array(count * 3);
    this.particleVelocities = new Float32Array(count * 3);
    this.particlePhases = new Float32Array(count);
    this.particleSpeeds = new Float32Array(count);
    this.baseOpacities = new Float32Array(count);
    this.colors = new Float32Array(count * 3);
    this.particleBoost = new Float32Array(count);
    this.particleBoost.fill(1.0);

    const spread = 1200;

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;

      this.particlePositions[i3] = (Math.random() - 0.5) * spread;
      this.particlePositions[i3 + 1] = (Math.random() - 0.5) * spread;
      this.particlePositions[i3 + 2] = (Math.random() - 0.5) * 600;

      const speed = 0.03 + Math.random() * 0.1;
      const angle = Math.random() * Math.PI * 2;
      const elevation = (Math.random() - 0.5) * Math.PI;
      this.particleVelocities[i3] =
        Math.cos(angle) * Math.cos(elevation) * speed;
      this.particleVelocities[i3 + 1] = Math.sin(elevation) * speed;
      this.particleVelocities[i3 + 2] =
        Math.sin(angle) * Math.cos(elevation) * speed * 0.3;

      this.particlePhases[i] = Math.random() * Math.PI * 2;
      this.particleSpeeds[i] = 0.5 + Math.random() * 1.0;
      this.baseOpacities[i] = 0.3 + Math.random() * 0.7;

      const t = (this.particlePositions[i3 + 2] + 300) / 600;
      this.colors[i3] = THREE.MathUtils.lerp(0, 1.2, t);
      this.colors[i3 + 1] = THREE.MathUtils.lerp(2.0, 0.8, t);
      this.colors[i3 + 2] = THREE.MathUtils.lerp(2.5, 2.0, t);
    }

    const renderColors = new Float32Array(count * 3);
    renderColors.set(this.colors);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.particlePositions, 3),
    );
    geometry.setAttribute(
      "color",
      new THREE.BufferAttribute(renderColors, 3),
    );

    const material = new THREE.PointsMaterial({
      size: 1.5,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      map: this.circleTexture,
    });

    this.particles = new THREE.Points(geometry, material);
    this.scene.add(this.particles);
  }

  private createCircleTexture(): THREE.Texture {
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;

    const half = size / 2;
    const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.3, "rgba(255,255,255,0.8)");
    gradient.addColorStop(0.7, "rgba(255,255,255,0.2)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");

    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  /* ========== Dynamic Constellation System ========== */

  private shuffleNumbersInPlace(values: number[]): void {
    for (let i = values.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = values[i];
      values[i] = values[j];
      values[j] = temp;
    }
  }

  private pickCandidateByScore<T extends { score: number }>(
    candidates: T[],
  ): T {
    if (candidates.length === 1) return candidates[0];

    const bestScore = candidates[0].score;
    const weights = new Array<number>(candidates.length);
    let totalWeight = 0;

    for (let i = 0; i < candidates.length; i++) {
      const relativeScore = Math.max(candidates[i].score - bestScore, 0);
      const weight = Math.exp(-relativeScore / MATCH_SELECTION_TEMPERATURE);
      weights[i] = weight;
      totalWeight += weight;
    }

    let pick = Math.random() * totalWeight;
    for (let i = 0; i < candidates.length; i++) {
      pick -= weights[i];
      if (pick <= 0) return candidates[i];
    }
    return candidates[candidates.length - 1];
  }

  private isParticleWithinScreenPadding(
    particleIndex: number,
    padding: number,
  ): boolean {
    const i3 = particleIndex * 3;
    this.projectionTemp
      .set(
        this.particlePositions[i3],
        this.particlePositions[i3 + 1],
        this.particlePositions[i3 + 2],
      )
      .project(this.camera);

    if (
      !Number.isFinite(this.projectionTemp.x) ||
      !Number.isFinite(this.projectionTemp.y) ||
      !Number.isFinite(this.projectionTemp.z)
    ) {
      return false;
    }

    const min = -1 - padding;
    const max = 1 + padding;
    return (
      this.projectionTemp.x >= min &&
      this.projectionTemp.x <= max &&
      this.projectionTemp.y >= min &&
      this.projectionTemp.y <= max &&
      this.projectionTemp.z >= -1 - SCREEN_Z_PADDING &&
      this.projectionTemp.z <= 1 + SCREEN_Z_PADDING
    );
  }

  private isConstellationWithinScreenPadding(
    lc: LiveConstellation,
    padding: number,
  ): boolean {
    for (const idx of lc.particleIndices) {
      if (this.isParticleWithinScreenPadding(idx, padding)) {
        return true;
      }
    }
    return false;
  }

  private tryMatchPatternToBlock(
    particleIndices: number[],
    def: ConstellationDef,
    blockCenterX: number,
    blockCenterY: number,
  ): PatternMatchResult | null {
    const starCount = def.stars.length;
    if (particleIndices.length < starCount) return null;

    let blockCenterZ = 0;
    for (const idx of particleIndices) {
      blockCenterZ += this.particlePositions[idx * 3 + 2];
    }
    blockCenterZ /= particleIndices.length;

    const sortedPool = particleIndices.slice();
    sortedPool.sort((a, b) => {
      const ax = this.particlePositions[a * 3] - blockCenterX;
      const ay = this.particlePositions[a * 3 + 1] - blockCenterY;
      const az = this.particlePositions[a * 3 + 2] - blockCenterZ;
      const bx = this.particlePositions[b * 3] - blockCenterX;
      const by = this.particlePositions[b * 3 + 1] - blockCenterY;
      const bz = this.particlePositions[b * 3 + 2] - blockCenterZ;
      return ax * ax + ay * ay + az * az - (bx * bx + by * by + bz * bz);
    });

    const poolSize = Math.min(
      sortedPool.length,
      Math.max(starCount * MATCH_POOL_MULTIPLIER, starCount + 4),
    );
    const pool = sortedPool.slice(0, poolSize);
    if (pool.length < starCount) return null;

    let clusterCenterX = 0;
    let clusterCenterY = 0;
    let clusterCenterZ = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const idx of pool) {
      const x = this.particlePositions[idx * 3];
      const y = this.particlePositions[idx * 3 + 1];
      const z = this.particlePositions[idx * 3 + 2];
      clusterCenterX += x;
      clusterCenterY += y;
      clusterCenterZ += z;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    clusterCenterX /= pool.length;
    clusterCenterY /= pool.length;
    clusterCenterZ /= pool.length;

    let patternCenterX = 0;
    let patternCenterY = 0;
    for (const [sx, sy] of def.stars) {
      patternCenterX += sx;
      patternCenterY += sy;
    }
    patternCenterX /= starCount;
    patternCenterY /= starCount;

    const centeredStars = new Array<{ x: number; y: number }>(starCount);
    let patternMinX = Infinity;
    let patternMinY = Infinity;
    let patternMaxX = -Infinity;
    let patternMaxY = -Infinity;

    for (let i = 0; i < starCount; i++) {
      const [sx, sy] = def.stars[i];
      const px = sx - patternCenterX;
      const py = sy - patternCenterY;
      centeredStars[i] = { x: px, y: py };
      if (px < patternMinX) patternMinX = px;
      if (px > patternMaxX) patternMaxX = px;
      if (py < patternMinY) patternMinY = py;
      if (py > patternMaxY) patternMaxY = py;
    }

    const patternSpan = Math.max(
      patternMaxX - patternMinX,
      patternMaxY - patternMinY,
      1,
    );
    const clusterSpan = Math.max(maxX - minX, maxY - minY, GRID_CELL_SIZE * 0.8);
    const baseScale = clusterSpan / patternSpan;

    const starOrder = Array.from({ length: starCount }, (_, i) => i);
    starOrder.sort((a, b) => {
      const ar =
        centeredStars[a].x * centeredStars[a].x +
        centeredStars[a].y * centeredStars[a].y;
      const br =
        centeredStars[b].x * centeredStars[b].x +
        centeredStars[b].y * centeredStars[b].y;
      return br - ar;
    });

    let best: PatternMatchResult | null = null;

    for (const scaleMul of MATCH_SCALE_VARIANTS) {
      const scale = baseScale * scaleMul;

      for (let ai = 0; ai < MATCH_ANGLE_STEPS; ai++) {
        const theta = (Math.PI * 2 * ai) / MATCH_ANGLE_STEPS;
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);

        const assigned = new Array<number>(starCount);
        const used = new Uint8Array(pool.length);

        let sumDistSq = 0;
        let maxDist = 0;
        let failed = false;

        for (const starIdx of starOrder) {
          const p = centeredStars[starIdx];
          const tx = clusterCenterX + (p.x * cosT - p.y * sinT) * scale;
          const ty = clusterCenterY + (p.x * sinT + p.y * cosT) * scale;
          const tz = clusterCenterZ;

          let bestPoolIdx = -1;
          let bestDistSq = Infinity;

          for (let pi = 0; pi < pool.length; pi++) {
            if (used[pi] === 1) continue;

            const idx = pool[pi];
            const dx = this.particlePositions[idx * 3] - tx;
            const dy = this.particlePositions[idx * 3 + 1] - ty;
            const dz = this.particlePositions[idx * 3 + 2] - tz;
            const distSq = dx * dx + dy * dy + dz * dz;

            if (distSq < bestDistSq) {
              bestDistSq = distSq;
              bestPoolIdx = pi;
            }
          }

          if (bestPoolIdx < 0) {
            failed = true;
            break;
          }

          used[bestPoolIdx] = 1;
          const chosenIdx = pool[bestPoolIdx];
          assigned[starIdx] = chosenIdx;

          sumDistSq += bestDistSq;
          const dist = Math.sqrt(bestDistSq);
          if (dist > maxDist) maxDist = dist;
        }

        if (failed) continue;
        if (maxDist > scale * 2.4) continue;

        const rmsError = Math.sqrt(sumDistSq / starCount);
        const normalizedError = rmsError / Math.max(scale, 1);
        const score = normalizedError;

        if (score > MATCH_QUALITY_THRESHOLD) continue;

        if (!best || score < best.score) {
          best = { particleIndices: assigned, score };
        }
      }
    }

    return best;
  }

  private findCluster(): void {
    const activeCount = this.liveConstellations.filter(
      (lc) => lc.state !== ConstellationState.Dissolved,
    ).length;
    if (activeCount >= this.maxConstellations) return;

    // Build 2D spatial hash grid in projected screen space (NDC).
    const grid = new Map<number, number[]>();
    const screenMin = -1 - SPAWN_SCREEN_PADDING;
    const screenMax = 1 + SPAWN_SCREEN_PADDING;
    const screenRange = screenMax - screenMin;
    const screenCellSize = screenRange / GRID_SIZE;

    this.camera.updateMatrixWorld();

    for (let i = 0; i < this.particleCount; i++) {
      if (this.usedParticleSet.has(i)) continue;

      const i3 = i * 3;
      this.projectionTemp
        .set(
          this.particlePositions[i3],
          this.particlePositions[i3 + 1],
          this.particlePositions[i3 + 2],
        )
        .project(this.camera);

      if (
        !Number.isFinite(this.projectionTemp.x) ||
        !Number.isFinite(this.projectionTemp.y) ||
        !Number.isFinite(this.projectionTemp.z)
      ) {
        continue;
      }

      if (
        this.projectionTemp.z < -1 - SCREEN_Z_PADDING ||
        this.projectionTemp.z > 1 + SCREEN_Z_PADDING
      ) {
        continue;
      }

      if (
        this.projectionTemp.x < screenMin || this.projectionTemp.x > screenMax ||
        this.projectionTemp.y < screenMin || this.projectionTemp.y > screenMax
      ) {
        continue;
      }

      const gx = Math.min(
        Math.floor((this.projectionTemp.x - screenMin) / screenCellSize),
        GRID_SIZE - 1,
      );
      const gy = Math.min(
        Math.floor((this.projectionTemp.y - screenMin) / screenCellSize),
        GRID_SIZE - 1,
      );
      const key = gy * GRID_SIZE + gx;
      let cell = grid.get(key);
      if (!cell) {
        cell = [];
        grid.set(key, cell);
      }
      cell.push(i);
    }

    // Determine which patterns are currently unused
    const usedPatterns = new Set(
      this.liveConstellations
        .filter((lc) => lc.state !== ConstellationState.Dissolved)
        .map((lc) => lc.patternIndex),
    );

    // Try to find a suitable 2x2 block
    const candidates: {
      particles: number[];
      centerX: number;
      centerY: number;
    }[] = [];

    for (let gy = 0; gy < GRID_SIZE - 1; gy++) {
      for (let gx = 0; gx < GRID_SIZE - 1; gx++) {
        const collected: number[] = [];
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const key = (gy + dy) * GRID_SIZE + (gx + dx);
            const cell = grid.get(key);
            if (cell) {
              for (const idx of cell) collected.push(idx);
            }
          }
        }
        // Need at least 5 particles for smallest constellation
        if (collected.length >= 5) {
          let centerX = 0;
          let centerY = 0;
          for (const idx of collected) {
            centerX += this.particlePositions[idx * 3];
            centerY += this.particlePositions[idx * 3 + 1];
          }
          centerX /= collected.length;
          centerY /= collected.length;
          candidates.push({ particles: collected, centerX, centerY });
        }
      }
    }

    if (candidates.length === 0) return;

    // Build pattern search order (unused patterns first)
    const unusedPatterns: number[] = [];
    const alreadyUsedPatterns: number[] = [];
    for (let i = 0; i < CONSTELLATION_DEFS.length; i++) {
      if (usedPatterns.has(i)) alreadyUsedPatterns.push(i);
      else unusedPatterns.push(i);
    }

    this.shuffleNumbersInPlace(unusedPatterns);
    this.shuffleNumbersInPlace(alreadyUsedPatterns);
    const patternOrder = [...unusedPatterns, ...alreadyUsedPatterns];

    // Shuffle blocks and search the best shape match.
    const candidateOrder = Array.from({ length: candidates.length }, (_, i) => i);
    this.shuffleNumbersInPlace(candidateOrder);

    const blockTryCount = Math.min(candidateOrder.length, CLUSTER_BLOCK_TRY_COUNT);
    const bestMatchByPattern = new Map<
      number,
      {
        patternIndex: number;
        particleIndices: number[];
        score: number;
      }
    >();

    for (let bi = 0; bi < blockTryCount; bi++) {
      const block = candidates[candidateOrder[bi]];
      const blockCenterX = block.centerX;
      const blockCenterY = block.centerY;

      for (const candidatePatternIndex of patternOrder) {
        const def = CONSTELLATION_DEFS[candidatePatternIndex];
        if (block.particles.length < def.stars.length) continue;

        const match = this.tryMatchPatternToBlock(
          block.particles,
          def,
          blockCenterX,
          blockCenterY,
        );
        if (!match) continue;

        // Bias correction: smaller pattern spans and lower star counts
        // are naturally easier to fit, so normalize their advantage.
        const spanNorm =
          PATTERN_SPANS[candidatePatternIndex] / AVG_PATTERN_SPAN;
        const spanCorrectedScore =
          match.score /
          Math.pow(Math.max(spanNorm, 0.4), PATTERN_SPAN_BIAS_POWER);
        const complexityRatio =
          AVG_PATTERN_STAR_COUNT /
          Math.max(PATTERN_STAR_COUNTS[candidatePatternIndex], 1);
        const complexityAdjustedScore =
          spanCorrectedScore *
          Math.pow(
            Math.max(complexityRatio, 0.7),
            PATTERN_COMPLEXITY_BIAS_POWER,
          );

        let totalScore = complexityAdjustedScore;

        if (usedPatterns.has(candidatePatternIndex)) {
          totalScore += ACTIVE_PATTERN_PENALTY;
        }

        const cooldownRemaining =
          this.patternCooldownUntil[candidatePatternIndex] - this.time;
        if (cooldownRemaining > 0) {
          const cooldownRatio = Math.min(
            cooldownRemaining / PATTERN_COOLDOWN_SECONDS,
            1,
          );
          totalScore += PATTERN_COOLDOWN_PENALTY * cooldownRatio;
        }

        const prev = bestMatchByPattern.get(candidatePatternIndex);
        if (!prev || totalScore < prev.score) {
          bestMatchByPattern.set(candidatePatternIndex, {
            patternIndex: candidatePatternIndex,
            particleIndices: match.particleIndices,
            score: totalScore,
          });
        }
      }
    }

    const patternCandidates = Array.from(bestMatchByPattern.values());
    if (patternCandidates.length === 0) return;

    patternCandidates.sort((a, b) => a.score - b.score);
    const topCandidates = patternCandidates.slice(
      0,
      Math.min(patternCandidates.length, MATCH_TOP_PATTERN_CHOICES),
    );
    const selected = this.pickCandidateByScore(topCandidates);

    const patternIndex = selected.patternIndex;
    const def = CONSTELLATION_DEFS[patternIndex];
    const needed = def.stars.length;
    const chosen = selected.particleIndices;
    if (chosen.length !== needed) return;

    this.patternCooldownUntil[patternIndex] =
      this.time + PATTERN_COOLDOWN_SECONDS;

    // Mark particles as used
    for (const idx of chosen) this.usedParticleSet.add(idx);

    // Snapshot anchor positions and compute initialMaxDist
    const anchors = new Float32Array(needed * 3);
    for (let i = 0; i < needed; i++) {
      const idx = chosen[i];
      anchors[i * 3] = this.particlePositions[idx * 3];
      anchors[i * 3 + 1] = this.particlePositions[idx * 3 + 1];
      anchors[i * 3 + 2] = this.particlePositions[idx * 3 + 2];
    }

    let maxDist = 0;
    for (let i = 0; i < needed; i++) {
      for (let j = i + 1; j < needed; j++) {
        const dx = anchors[i * 3] - anchors[j * 3];
        const dy = anchors[i * 3 + 1] - anchors[j * 3 + 1];
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > maxDist) maxDist = d;
      }
    }
    if (maxDist < 1) maxDist = 1;

    // Create line geometry
    const lineCount = def.lines.length;
    const linePositions = new Float32Array(lineCount * 2 * 3);
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(linePositions, 3),
    );

    const baseColor =
      PALETTE_COLORS[this.colorCycleIndex % PALETTE_COLORS.length];
    this.colorCycleIndex++;

    const lineMaterial = new THREE.LineBasicMaterial({
      color: baseColor,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const lineSegments = new THREE.LineSegments(lineGeometry, lineMaterial);
    this.scene.add(lineSegments);

    const lc: LiveConstellation = {
      patternIndex,
      state: ConstellationState.Forming,
      particleIndices: chosen,
      lineSegments,
      lineGeometry,
      lineMaterial,
      anchorPositions: anchors,
      initialMaxDist: maxDist,
      opacity: 0,
      formStartTime: this.time,
      fadeStartTime: 0,
      spreadRatio: 1,
      baseColor: baseColor.clone(),
      starBoost: STAR_BOOST_MAX,
      lineProgress: new Array(lineCount).fill(0),
      lineFlashTimers: new Array(lineCount).fill(-1),
    };

    this.liveConstellations.push(lc);
  }

  private updateConstellations(dt: number): void {
    // Reset particle boost
    this.particleBoost.fill(1.0);
    this.camera.updateMatrixWorld();

    for (let ci = this.liveConstellations.length - 1; ci >= 0; ci--) {
      const lc = this.liveConstellations[ci];

      if (lc.state === ConstellationState.Dissolved) {
        this.liveConstellations.splice(ci, 1);
        continue;
      }

      const def = CONSTELLATION_DEFS[lc.patternIndex];
      const state = lc.state;
      let dissolvedThisFrame = false;

      // --- State machine ---

      if (state === ConstellationState.Forming) {
        this.updateForming(lc, def);
      } else if (state === ConstellationState.Active) {
        this.updateActive(lc);
      } else if (state === ConstellationState.Fading) {
        dissolvedThisFrame = this.updateFading(lc);
      }

      if (
        lc.state === ConstellationState.Forming &&
        this.detectWrap(lc)
      ) {
        lc.state = ConstellationState.Fading;
        lc.fadeStartTime = this.time;
      }

      if (lc.state !== ConstellationState.Fading) {
        const lifetime = this.time - lc.formStartTime;
        if (
          lifetime >= MIN_ONSCREEN_LIFETIME &&
          !this.isConstellationWithinScreenPadding(lc, DESPAWN_SCREEN_PADDING)
        ) {
          lc.state = ConstellationState.Fading;
          lc.fadeStartTime = this.time;
        }
      }

      if (dissolvedThisFrame) {
        this.liveConstellations.splice(ci, 1);
        continue;
      }

      // Apply star brightness boost
      const boostVal = 1.0 + (lc.starBoost - 1.0) * lc.opacity;
      for (const idx of lc.particleIndices) {
        this.particleBoost[idx] = Math.max(this.particleBoost[idx], boostVal);
      }

      // Update line positions from current particle positions
      this.updateLinePositions(lc, def);

      // Update material opacity with flash effect
      let maxFlash = 1.0;
      for (let li = 0; li < lc.lineFlashTimers.length; li++) {
        if (lc.lineFlashTimers[li] > 0) {
          const flashRatio = lc.lineFlashTimers[li] / FLASH_DURATION;
          const flashMul = 1.0 + (FLASH_INTENSITY - 1.0) * flashRatio;
          if (flashMul > maxFlash) maxFlash = flashMul;
          lc.lineFlashTimers[li] -= dt;
        }
      }
      lc.lineMaterial.opacity = lc.opacity * 0.15 * maxFlash;
    }
  }

  private updateForming(
    lc: LiveConstellation,
    def: ConstellationDef,
  ): void {
    const elapsed = this.time - lc.formStartTime;
    const totalLines = def.lines.length;
    let allDone = true;

    for (let li = 0; li < totalLines; li++) {
      const lineStartTime = li * LINE_STAGGER;
      const lineElapsed = elapsed - lineStartTime;
      const wasComplete = lc.lineProgress[li] >= 1.0;

      if (lineElapsed <= 0) {
        lc.lineProgress[li] = 0;
        allDone = false;
        continue;
      }

      const progress = Math.min(lineElapsed / LINE_DRAW_DURATION, 1.0);
      lc.lineProgress[li] = progress;

      // Trigger flash once when the line first reaches the endpoint.
      if (!wasComplete && progress >= 1.0) {
        lc.lineFlashTimers[li] = FLASH_DURATION;
      }

      if (progress < 1.0) allDone = false;
    }

    // Fade in opacity during forming
    const formDuration = (totalLines - 1) * LINE_STAGGER + LINE_DRAW_DURATION;
    lc.opacity = Math.min(elapsed / Math.min(formDuration, 1.0), 1.0);

    // Check if all flashes finished too
    if (allDone) {
      let flashesDone = true;
      for (let li = 0; li < totalLines; li++) {
        if (lc.lineFlashTimers[li] > 0) {
          flashesDone = false;
          break;
        }
      }
      if (flashesDone) {
        lc.state = ConstellationState.Active;
      }
    }
  }

  private updateActive(lc: LiveConstellation): void {
    // Apply repulsion force between constellation particles
    const indices = lc.particleIndices;
    const n = indices.length;

    // Compute center
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < n; i++) {
      const idx = indices[i];
      cx += this.particlePositions[idx * 3];
      cy += this.particlePositions[idx * 3 + 1];
    }
    cx /= n;
    cy /= n;

    // Push each particle away from center
    for (let i = 0; i < n; i++) {
      const idx = indices[i];
      const i3 = idx * 3;
      const dx = this.particlePositions[i3] - cx;
      const dy = this.particlePositions[i3 + 1] - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 0.1) {
        // Particle velocities are treated as per-frame deltas in this file,
        // so repulsion should use the same unit scale (not dt-scaled).
        this.particleVelocities[i3] += (dx / dist) * REPULSION_FORCE;
        this.particleVelocities[i3 + 1] += (dy / dist) * REPULSION_FORCE;
      }
    }

    // Compute spread ratio
    this.computeSpread(lc);

    if (lc.spreadRatio >= SPREAD_FADE_START) {
      lc.state = ConstellationState.Fading;
      lc.fadeStartTime = this.time;
    }

    // Check for wrap-around
    if (this.detectWrap(lc)) {
      lc.state = ConstellationState.Fading;
      lc.fadeStartTime = this.time;
    }

    lc.opacity = 1.0;
  }

  private updateFading(lc: LiveConstellation): boolean {
    this.computeSpread(lc);

    // Spread-based opacity
    const spreadOpacity =
      lc.spreadRatio >= SPREAD_DISSOLVE
        ? 0
        : lc.spreadRatio <= SPREAD_FADE_START
          ? 1
          : 1 -
            (lc.spreadRatio - SPREAD_FADE_START) /
              (SPREAD_DISSOLVE - SPREAD_FADE_START);

    // Time-based opacity
    const timeElapsed = this.time - lc.fadeStartTime;
    const timeOpacity = Math.max(1 - timeElapsed / FADE_DURATION, 0);

    lc.opacity = Math.min(spreadOpacity, timeOpacity);

    if (lc.opacity <= 0) {
      this.dissolveConstellation(lc);
      return true;
    }
    return false;
  }

  private computeSpread(lc: LiveConstellation): void {
    let totalDisp = 0;
    const n = lc.particleIndices.length;

    for (let i = 0; i < n; i++) {
      const idx = lc.particleIndices[i];
      const dx =
        this.particlePositions[idx * 3] - lc.anchorPositions[i * 3];
      const dy =
        this.particlePositions[idx * 3 + 1] - lc.anchorPositions[i * 3 + 1];
      totalDisp += Math.sqrt(dx * dx + dy * dy);
    }

    const avgDisp = totalDisp / n;
    lc.spreadRatio = 1 + avgDisp / lc.initialMaxDist;
  }

  private detectWrap(lc: LiveConstellation): boolean {
    for (let i = 0; i < lc.particleIndices.length; i++) {
      const idx = lc.particleIndices[i];
      const dx = Math.abs(
        this.particlePositions[idx * 3] - lc.anchorPositions[i * 3],
      );
      const dy = Math.abs(
        this.particlePositions[idx * 3 + 1] - lc.anchorPositions[i * 3 + 1],
      );
      if (dx > WRAP_DETECT_DIST || dy > WRAP_DETECT_DIST) return true;
    }
    return false;
  }

  private dissolveConstellation(lc: LiveConstellation): void {
    lc.state = ConstellationState.Dissolved;

    // Release particles
    for (const idx of lc.particleIndices) {
      this.usedParticleSet.delete(idx);
    }

    // Cleanup GPU resources
    this.scene.remove(lc.lineSegments);
    lc.lineGeometry.dispose();
    lc.lineMaterial.dispose();
  }

  private updateLinePositions(
    lc: LiveConstellation,
    def: ConstellationDef,
  ): void {
    const posAttr = lc.lineGeometry.attributes
      .position as THREE.BufferAttribute;
    const arr = posAttr.array as Float32Array;

    for (let li = 0; li < def.lines.length; li++) {
      const [fromStar, toStar] = def.lines[li];
      const fromIdx = lc.particleIndices[fromStar];
      const toIdx = lc.particleIndices[toStar];

      const fx = this.particlePositions[fromIdx * 3];
      const fy = this.particlePositions[fromIdx * 3 + 1];
      const fz = this.particlePositions[fromIdx * 3 + 2];

      const tx = this.particlePositions[toIdx * 3];
      const ty = this.particlePositions[toIdx * 3 + 1];
      const tz = this.particlePositions[toIdx * 3 + 2];

      const progress = lc.lineProgress[li];

      const v = li * 6; // 2 vertices * 3 components
      arr[v] = fx;
      arr[v + 1] = fy;
      arr[v + 2] = fz;

      // Second vertex lerps from "from" to "to" based on progress
      arr[v + 3] = fx + (tx - fx) * progress;
      arr[v + 4] = fy + (ty - fy) * progress;
      arr[v + 5] = fz + (tz - fz) * progress;
    }

    posAttr.needsUpdate = true;
  }

  /* ========== End Dynamic Constellation System ========== */

  private updateScrollConfig(): void {
    const isMobile = window.innerWidth < 768;
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const baseConfig = isMobile ? SCROLL_MOBILE_CONFIG : SCROLL_DESKTOP_CONFIG;
    const motionScale = prefersReducedMotion ? REDUCED_MOTION_SCALE : 1.0;

    this.scrollConfig = {
      impulse: baseConfig.impulse * motionScale,
      damping: baseConfig.damping,
      yClamp: baseConfig.yClamp * motionScale,
      pitchClamp: baseConfig.pitchClamp * motionScale,
      deltaClamp: baseConfig.deltaClamp,
    };

    this.scrollTargetYOffset = THREE.MathUtils.clamp(
      this.scrollTargetYOffset,
      -this.scrollConfig.yClamp,
      this.scrollConfig.yClamp,
    );
    this.scrollCurrentYOffset = THREE.MathUtils.clamp(
      this.scrollCurrentYOffset,
      -this.scrollConfig.yClamp,
      this.scrollConfig.yClamp,
    );
    this.scrollTargetPitch = THREE.MathUtils.clamp(
      this.scrollTargetPitch,
      -this.scrollConfig.pitchClamp,
      this.scrollConfig.pitchClamp,
    );
    this.scrollCurrentPitch = THREE.MathUtils.clamp(
      this.scrollCurrentPitch,
      -this.scrollConfig.pitchClamp,
      this.scrollConfig.pitchClamp,
    );
  }

  private bindEvents(): void {
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("scroll", this.onScroll, { passive: true });
    window.addEventListener("resize", this.onResize);

    const canvas = this.renderer.domElement;
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
  }

  private onMouseMove = (e: MouseEvent): void => {
    this.targetMouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    this.targetMouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    this.targetMouseScreen.x = e.clientX;
    this.targetMouseScreen.y = e.clientY;
  };

  private onScroll = (): void => {
    const nextY = window.scrollY || window.pageYOffset || 0;
    let delta = nextY - this.lastScrollY;
    this.lastScrollY = nextY;

    if (delta === 0) return;

    delta = THREE.MathUtils.clamp(
      delta,
      -this.scrollConfig.deltaClamp,
      this.scrollConfig.deltaClamp,
    );

    const nextTargetOffset =
      this.scrollTargetYOffset - delta * this.scrollConfig.impulse;
    this.scrollTargetYOffset = THREE.MathUtils.clamp(
      nextTargetOffset,
      -this.scrollConfig.yClamp,
      this.scrollConfig.yClamp,
    );

    const normalized =
      this.scrollConfig.yClamp > 0
        ? this.scrollTargetYOffset / this.scrollConfig.yClamp
        : 0;

    this.scrollTargetPitch = THREE.MathUtils.clamp(
      normalized * this.scrollConfig.pitchClamp,
      -this.scrollConfig.pitchClamp,
      this.scrollConfig.pitchClamp,
    );
  };

  private onResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.updateScrollConfig();
  };

  private onContextLost = (e: Event): void => {
    e.preventDefault();
    cancelAnimationFrame(this.rafId);
  };

  private onContextRestored = (): void => {
    this.animate();
  };

  private animate = (): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.animate);

    const dt = 0.016;
    this.time += dt;

    this.mouse.x += (this.targetMouse.x - this.mouse.x) * 0.05;
    this.mouse.y += (this.targetMouse.y - this.mouse.y) * 0.05;
    this.mouseScreen.x +=
      (this.targetMouseScreen.x - this.mouseScreen.x) * 0.08;
    this.mouseScreen.y +=
      (this.targetMouseScreen.y - this.mouseScreen.y) * 0.08;
    this.scrollTargetYOffset *= this.scrollConfig.damping;
    this.scrollTargetPitch *= this.scrollConfig.damping;
    this.scrollCurrentYOffset +=
      (this.scrollTargetYOffset - this.scrollCurrentYOffset) * SCROLL_LERP;
    this.scrollCurrentPitch +=
      (this.scrollTargetPitch - this.scrollCurrentPitch) * SCROLL_LERP;

    // Spotlight
    if (this.spotlightEl) {
      this.spotlightEl.style.background = `radial-gradient(
        600px circle at ${this.mouseScreen.x}px ${this.mouseScreen.y}px,
        transparent 0%,
        rgba(10, 10, 15, 0.3) 40%,
        rgba(10, 10, 15, 0.7) 70%,
        rgba(10, 10, 15, 0.9) 100%
      )`;
    }

    // Cluster search
    if (this.time - this.lastClusterSearch >= CLUSTER_SEARCH_INTERVAL) {
      this.lastClusterSearch = this.time;
      this.findCluster();
    }

    // Update dynamic constellations (also sets particleBoost)
    this.updateConstellations(dt);

    // Update particles
    const bound = 600;
    const colorAttr = this.particles.geometry.attributes
      .color as THREE.BufferAttribute;

    for (let i = 0; i < this.particleCount; i++) {
      const i3 = i * 3;
      this.particlePositions[i3] += this.particleVelocities[i3];
      this.particlePositions[i3 + 1] += this.particleVelocities[i3 + 1];
      this.particlePositions[i3 + 2] += this.particleVelocities[i3 + 2];

      if (this.particlePositions[i3] > bound)
        this.particlePositions[i3] = -bound;
      else if (this.particlePositions[i3] < -bound)
        this.particlePositions[i3] = bound;
      if (this.particlePositions[i3 + 1] > bound)
        this.particlePositions[i3 + 1] = -bound;
      else if (this.particlePositions[i3 + 1] < -bound)
        this.particlePositions[i3 + 1] = bound;

      const boost = this.particleBoost[i];
      const twinkle =
        0.3 +
        0.7 *
          this.baseOpacities[i] *
          (0.5 +
            0.5 *
              Math.sin(
                this.time * this.particleSpeeds[i] + this.particlePhases[i],
              ));

      colorAttr.array[i3] = this.colors[i3] * twinkle * boost;
      colorAttr.array[i3 + 1] = this.colors[i3 + 1] * twinkle * boost;
      colorAttr.array[i3 + 2] = this.colors[i3 + 2] * twinkle * boost;
    }

    (
      this.particles.geometry.attributes.position as THREE.BufferAttribute
    ).needsUpdate = true;
    colorAttr.needsUpdate = true;

    // Camera parallax
    this.camera.position.x = this.mouse.x * 60;
    this.camera.position.y = this.mouse.y * 40 + this.scrollCurrentYOffset;
    const lookAtYOffset =
      Math.tan(this.scrollCurrentPitch) * this.camera.position.z;
    this.camera.lookAt(0, lookAtYOffset, 0);

    this.composer.render();
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("scroll", this.onScroll);
    window.removeEventListener("resize", this.onResize);

    const canvas = this.renderer.domElement;
    canvas.removeEventListener("webglcontextlost", this.onContextLost);
    canvas.removeEventListener("webglcontextrestored", this.onContextRestored);

    this.particles.geometry.dispose();
    (this.particles.material as THREE.Material).dispose();

    // Cleanup live constellations
    for (const lc of this.liveConstellations) {
      if (lc.state !== ConstellationState.Dissolved) {
        this.scene.remove(lc.lineSegments);
        lc.lineGeometry.dispose();
        lc.lineMaterial.dispose();
      }
    }
    this.liveConstellations.length = 0;
    this.usedParticleSet.clear();

    this.circleTexture.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}
