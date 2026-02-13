import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

interface ParticleFieldOptions {
  canvas: HTMLCanvasElement;
}

export class ParticleField {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private particles!: THREE.Points;
  private lines!: THREE.LineSegments;
  private particleCount: number;
  private particlePositions!: Float32Array;
  private particleVelocities!: Float32Array;
  private particlePhases!: Float32Array;
  private particleSpeeds!: Float32Array;
  private baseOpacities!: Float32Array;
  private colors!: Float32Array;
  private linePositions!: Float32Array;
  private lineColors!: Float32Array;
  private mouse = { x: 0, y: 0 };
  private targetMouse = { x: 0, y: 0 };
  private mouseScreen = { x: 0.5, y: 0.5 };
  private targetMouseScreen = { x: 0.5, y: 0.5 };
  private spotlightEl: HTMLElement | null;
  private rafId = 0;
  private maxConnections: number;
  private connectionDistance: number;
  private disposed = false;
  private time = 0;

  constructor(options: ParticleFieldOptions) {
    const isMobile = window.innerWidth < 768;
    this.particleCount = isMobile ? 1500 : this.getAdaptiveCount();
    this.maxConnections = isMobile ? 80 : 200;
    this.connectionDistance = isMobile ? 100 : 120;

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

    // Post-processing: bloom
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      1.5,  // strength — strong glow
      0.6,  // radius — wide spread
      0.1,  // threshold — catch dimmer particles too
    );
    this.composer.addPass(bloomPass);

    // Mouse spotlight overlay
    this.spotlightEl = document.getElementById("mouse-spotlight");

    this.initParticles();
    this.initLines();
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
      // Extension unavailable in some browsers
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

      const speed = 0.1 + Math.random() * 0.4;
      const angle = Math.random() * Math.PI * 2;
      const elevation = (Math.random() - 0.5) * Math.PI;
      this.particleVelocities[i3] =
        Math.cos(angle) * Math.cos(elevation) * speed;
      this.particleVelocities[i3 + 1] = Math.sin(elevation) * speed;
      this.particleVelocities[i3 + 2] =
        Math.sin(angle) * Math.cos(elevation) * speed * 0.3;

      this.particlePhases[i] = Math.random() * Math.PI * 2;
      this.particleSpeeds[i] = 1.5 + Math.random() * 3.0;
      this.baseOpacities[i] = 0.3 + Math.random() * 0.7;

      // Brighter colors so bloom catches them — HDR range (>1.0)
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
    });

    this.particles = new THREE.Points(geometry, material);
    this.scene.add(this.particles);
  }

  private initLines(): void {
    const maxLines = this.maxConnections;
    this.linePositions = new Float32Array(maxLines * 6);
    this.lineColors = new Float32Array(maxLines * 6);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.linePositions, 3),
    );
    geometry.setAttribute(
      "color",
      new THREE.BufferAttribute(this.lineColors, 3),
    );
    geometry.setDrawRange(0, 0);

    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.25,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.lines = new THREE.LineSegments(geometry, material);
    this.scene.add(this.lines);
  }

  private updateLines(): void {
    const positions = this.particlePositions;
    const dist = this.connectionDistance;
    const distSq = dist * dist;
    const maxLines = this.maxConnections;
    let lineIdx = 0;

    const step = Math.max(1, Math.floor(this.particleCount / 2000));

    for (
      let i = 0;
      i < this.particleCount && lineIdx < maxLines;
      i += step
    ) {
      const ix = positions[i * 3];
      const iy = positions[i * 3 + 1];
      const iz = positions[i * 3 + 2];

      for (
        let j = i + step;
        j < this.particleCount && lineIdx < maxLines;
        j += step
      ) {
        const dx = ix - positions[j * 3];
        const dy = iy - positions[j * 3 + 1];
        const dz = iz - positions[j * 3 + 2];
        const d2 = dx * dx + dy * dy + dz * dz;

        if (d2 < distSq) {
          const alpha = 1.0 - d2 / distSq;
          const i6 = lineIdx * 6;

          this.linePositions[i6] = ix;
          this.linePositions[i6 + 1] = iy;
          this.linePositions[i6 + 2] = iz;
          this.linePositions[i6 + 3] = positions[j * 3];
          this.linePositions[i6 + 4] = positions[j * 3 + 1];
          this.linePositions[i6 + 5] = positions[j * 3 + 2];

          this.lineColors[i6] = 0;
          this.lineColors[i6 + 1] = 1.8 * alpha;
          this.lineColors[i6 + 2] = 2.0 * alpha;
          this.lineColors[i6 + 3] = 0;
          this.lineColors[i6 + 4] = 1.8 * alpha;
          this.lineColors[i6 + 5] = 2.0 * alpha;

          lineIdx++;
        }
      }
    }

    const geom = this.lines.geometry;
    geom.setDrawRange(0, lineIdx * 2);
    (geom.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (geom.attributes.color as THREE.BufferAttribute).needsUpdate = true;
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

    // Update spotlight overlay position
    if (this.spotlightEl) {
      this.spotlightEl.style.background = `radial-gradient(
        600px circle at ${this.mouseScreen.x}px ${this.mouseScreen.y}px,
        transparent 0%,
        rgba(10, 10, 15, 0.3) 40%,
        rgba(10, 10, 15, 0.7) 70%,
        rgba(10, 10, 15, 0.9) 100%
      )`;
    }

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

      // Twinkle
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

    this.camera.position.x = this.mouse.x * 60;
    this.camera.position.y = this.mouse.y * 40;
    this.camera.lookAt(0, 0, 0);

    this.updateLines();
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
    this.lines.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}
