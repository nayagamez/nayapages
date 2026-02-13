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

interface ConstellationObj {
  group: THREE.Group;
  phase: number;
  bobAmplitude: number;
  rotSpeed: number;
  basePosition: THREE.Vector3;
}

// Real constellation patterns (simplified coordinates)
const CONSTELLATION_DEFS: ConstellationDef[] = [
  // Orion (오리온) — shoulders, belt, feet
  {
    stars: [
      [1, 8], [4, 8],           // shoulders
      [1.5, 5.5], [2.5, 5.5], [3.5, 5.5], // belt
      [0.5, 2], [4.5, 2],      // feet
      [2.5, 3.5],               // sword
    ],
    lines: [
      [0, 2], [1, 4],           // shoulders to belt
      [2, 3], [3, 4],           // belt
      [2, 5], [4, 6],           // belt to feet
      [3, 7],                   // sword
    ],
  },
  // Big Dipper (북두칠성)
  {
    stars: [
      [0, 0], [1.8, 0.4], [3.5, 0.2], [5, 1.2], // handle
      [5.5, 3], [4, 3.8], [5.2, 4.5],             // cup
    ],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 3]],
  },
  // Cassiopeia (카시오페이아) — W shape
  {
    stars: [[0, 2], [1.5, 0], [3, 1.8], [4.5, 0], [6, 2]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4]],
  },
  // Cygnus (백조자리) — cross shape
  {
    stars: [
      [3, 0], [3, 2], [3, 4], [3, 6], // body (vertical)
      [0.5, 3], [5.5, 3],             // wings
    ],
    lines: [[0, 1], [1, 2], [2, 3], [4, 2], [2, 5]],
  },
  // Scorpius (전갈자리) — curved tail
  {
    stars: [
      [1, 5], [2, 4.5], [2.5, 3.5], [2.5, 2.5],
      [3, 1.5], [4, 1], [5, 1.5], [5.5, 2.5],
    ],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7]],
  },
  // Lyra (거문고자리) — small diamond with tail
  {
    stars: [[2, 5], [1, 3], [3, 3], [1.5, 1.5], [2.5, 1.5]],
    lines: [[0, 1], [0, 2], [1, 3], [2, 4], [3, 4]],
  },
  // Gemini (쌍둥이자리) — two parallel lines
  {
    stars: [
      [0, 6], [0.5, 4], [1, 2], [1.5, 0],   // left twin
      [3, 6], [2.5, 4], [2, 2], [1.8, 0.5],  // right twin
    ],
    lines: [[0, 1], [1, 2], [2, 3], [4, 5], [5, 6], [6, 7], [0, 4], [2, 6]],
  },
];

export class ParticleField {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private particles!: THREE.Points;
  private constellations: ConstellationObj[] = [];
  private particleCount: number;
  private particlePositions!: Float32Array;
  private particleVelocities!: Float32Array;
  private particlePhases!: Float32Array;
  private particleSpeeds!: Float32Array;
  private baseOpacities!: Float32Array;
  private colors!: Float32Array;
  private circleTexture!: THREE.Texture;
  private mouse = { x: 0, y: 0 };
  private targetMouse = { x: 0, y: 0 };
  private mouseScreen = { x: 0.5, y: 0.5 };
  private targetMouseScreen = { x: 0.5, y: 0.5 };
  private spotlightEl: HTMLElement | null;
  private rafId = 0;
  private disposed = false;
  private time = 0;

  constructor(options: ParticleFieldOptions) {
    const isMobile = window.innerWidth < 768;
    this.particleCount = isMobile
      ? 800
      : Math.min(this.getAdaptiveCount(), 5000);

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

    this.initParticles();
    this.initConstellations(isMobile);
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

  private initConstellations(isMobile: boolean): void {
    const count = isMobile ? 3 : 5;
    const scale = 25;

    // Well-spaced positions for constellations
    const positions: THREE.Vector3[] = [];
    const minDist = 280;

    for (let ci = 0; ci < count; ci++) {
      const def = CONSTELLATION_DEFS[ci % CONSTELLATION_DEFS.length];

      let pos: THREE.Vector3;
      let attempts = 0;
      do {
        pos = new THREE.Vector3(
          (Math.random() - 0.5) * 800,
          (Math.random() - 0.5) * 600,
          (Math.random() - 0.5) * 200 - 100,
        );
        attempts++;
      } while (
        attempts < 50 &&
        positions.some((p) => p.distanceTo(pos) < minDist)
      );
      positions.push(pos);

      const group = new THREE.Group();
      group.position.copy(pos);
      group.rotation.z = Math.random() * Math.PI * 2;

      // Center constellation around its own origin
      let cx = 0;
      let cy = 0;
      for (const [sx, sy] of def.stars) {
        cx += sx;
        cy += sy;
      }
      cx /= def.stars.length;
      cy /= def.stars.length;

      const starPositions: THREE.Vector3[] = [];
      const starPosArray = new Float32Array(def.stars.length * 3);
      const starColorArray = new Float32Array(def.stars.length * 3);

      // Color per constellation: gradient from cyan to purple
      const ct = ci / Math.max(count - 1, 1);
      const starColor = new THREE.Color().lerpColors(
        new THREE.Color(0.3, 2.0, 2.5),
        new THREE.Color(1.2, 0.6, 2.0),
        ct,
      );
      const lineColor = new THREE.Color().lerpColors(
        new THREE.Color(0.1, 1.0, 1.2),
        new THREE.Color(0.6, 0.3, 1.0),
        ct,
      );

      for (let si = 0; si < def.stars.length; si++) {
        const [sx, sy] = def.stars[si];
        const x = (sx - cx) * scale;
        const y = (sy - cy) * scale;
        const z = (Math.random() - 0.5) * 8;

        starPosArray[si * 3] = x;
        starPosArray[si * 3 + 1] = y;
        starPosArray[si * 3 + 2] = z;
        starPositions.push(new THREE.Vector3(x, y, z));

        starColorArray[si * 3] = starColor.r;
        starColorArray[si * 3 + 1] = starColor.g;
        starColorArray[si * 3 + 2] = starColor.b;
      }

      // Constellation star points (brighter & larger than background)
      const starGeo = new THREE.BufferGeometry();
      starGeo.setAttribute(
        "position",
        new THREE.BufferAttribute(starPosArray, 3),
      );
      starGeo.setAttribute(
        "color",
        new THREE.BufferAttribute(starColorArray, 3),
      );

      const starMat = new THREE.PointsMaterial({
        size: 4,
        sizeAttenuation: true,
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        map: this.circleTexture,
      });

      group.add(new THREE.Points(starGeo, starMat));

      // Connection lines
      const lineVerts: number[] = [];
      const lineColorVerts: number[] = [];

      for (const [from, to] of def.lines) {
        const fp = starPositions[from];
        const tp = starPositions[to];
        lineVerts.push(fp.x, fp.y, fp.z, tp.x, tp.y, tp.z);
        lineColorVerts.push(
          lineColor.r, lineColor.g, lineColor.b,
          lineColor.r, lineColor.g, lineColor.b,
        );
      }

      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(lineVerts), 3),
      );
      lineGeo.setAttribute(
        "color",
        new THREE.BufferAttribute(new Float32Array(lineColorVerts), 3),
      );

      const lineMat = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.15,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });

      group.add(new THREE.LineSegments(lineGeo, lineMat));

      this.scene.add(group);

      this.constellations.push({
        group,
        phase: Math.random() * Math.PI * 2,
        bobAmplitude: 5 + Math.random() * 10,
        rotSpeed: (Math.random() - 0.5) * 0.008,
        basePosition: pos.clone(),
      });
    }
  }

  private bindEvents(): void {
    window.addEventListener("mousemove", this.onMouseMove);
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

  private onResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
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

    this.time += 0.016;

    this.mouse.x += (this.targetMouse.x - this.mouse.x) * 0.05;
    this.mouse.y += (this.targetMouse.y - this.mouse.y) * 0.05;
    this.mouseScreen.x +=
      (this.targetMouseScreen.x - this.mouseScreen.x) * 0.08;
    this.mouseScreen.y +=
      (this.targetMouseScreen.y - this.mouseScreen.y) * 0.08;

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

      const twinkle =
        0.3 +
        0.7 *
          this.baseOpacities[i] *
          (0.5 +
            0.5 *
              Math.sin(
                this.time * this.particleSpeeds[i] + this.particlePhases[i],
              ));

      colorAttr.array[i3] = this.colors[i3] * twinkle;
      colorAttr.array[i3 + 1] = this.colors[i3 + 1] * twinkle;
      colorAttr.array[i3 + 2] = this.colors[i3 + 2] * twinkle;
    }

    (
      this.particles.geometry.attributes.position as THREE.BufferAttribute
    ).needsUpdate = true;
    colorAttr.needsUpdate = true;

    // Update constellations — gentle drift & slow rotation
    for (const c of this.constellations) {
      c.group.position.x =
        c.basePosition.x +
        Math.sin(this.time * 0.3 + c.phase) * c.bobAmplitude;
      c.group.position.y =
        c.basePosition.y +
        Math.sin(this.time * 0.2 + c.phase * 1.3) * c.bobAmplitude;
      c.group.rotation.z += c.rotSpeed * 0.016;
    }

    // Camera parallax
    this.camera.position.x = this.mouse.x * 60;
    this.camera.position.y = this.mouse.y * 40;
    this.camera.lookAt(0, 0, 0);

    this.composer.render();
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("resize", this.onResize);

    const canvas = this.renderer.domElement;
    canvas.removeEventListener("webglcontextlost", this.onContextLost);
    canvas.removeEventListener("webglcontextrestored", this.onContextRestored);

    this.particles.geometry.dispose();
    (this.particles.material as THREE.Material).dispose();

    for (const c of this.constellations) {
      c.group.traverse((obj) => {
        if (obj instanceof THREE.Points || obj instanceof THREE.LineSegments) {
          obj.geometry.dispose();
          (obj.material as THREE.Material).dispose();
        }
      });
    }

    this.circleTexture.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}
