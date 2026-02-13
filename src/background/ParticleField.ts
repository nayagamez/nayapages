import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

interface ParticleFieldOptions {
  canvas: HTMLCanvasElement;
}

interface FloatingShape {
  mesh: THREE.LineSegments;
  rotSpeed: THREE.Vector3;
  basePosition: THREE.Vector3;
  phase: number;
  bobAmplitude: number;
  parentIdx?: number; // orbit rings track their parent nucleus
}

interface Synapse {
  line: THREE.Line;
  fromIdx: number;
  toIdx: number;
  flowPhase: number;
  flowSpeed: number;
}

export class ParticleField {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private particles!: THREE.Points;
  private shapes: FloatingShape[] = [];
  private synapses: Synapse[] = [];
  private particleCount: number;
  private particlePositions!: Float32Array;
  private particleVelocities!: Float32Array;
  private particlePhases!: Float32Array;
  private particleSpeeds!: Float32Array;
  private baseOpacities!: Float32Array;
  private colors!: Float32Array;
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
    this.particleCount = isMobile ? 800 : Math.min(this.getAdaptiveCount(), 5000);

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

    this.initParticles();
    this.initShapes(isMobile);
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
      map: this.createCircleTexture(),
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

  private createRingGeometry(segments = 64): THREE.BufferGeometry {
    const positions = new Float32Array(segments * 6);
    for (let i = 0; i < segments; i++) {
      const a1 = (i / segments) * Math.PI * 2;
      const a2 = ((i + 1) / segments) * Math.PI * 2;
      const idx = i * 6;
      positions[idx] = Math.cos(a1);
      positions[idx + 1] = Math.sin(a1);
      positions[idx + 2] = 0;
      positions[idx + 3] = Math.cos(a2);
      positions[idx + 4] = Math.sin(a2);
      positions[idx + 5] = 0;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return geo;
  }

  private initShapes(isMobile: boolean): void {
    // Molecular / atomic structure:
    //   Nuclei  = wireframe polyhedra (Icosahedron, Dodecahedron, Octahedron)
    //   Orbits  = electron-shell rings tilted at various angles
    //   Bonds   = lines connecting nearby atoms
    const atomDefs = [
      { geo: () => new THREE.IcosahedronGeometry(1, 1), scaleRange: [50, 70], orbits: 2 },
      { geo: () => new THREE.DodecahedronGeometry(1, 0), scaleRange: [35, 55], orbits: 1 },
      { geo: () => new THREE.OctahedronGeometry(1, 0), scaleRange: [25, 45], orbits: 1 },
    ];

    const atomCount = isMobile ? 3 : 5;

    // Well-spaced positions
    const atomPositions: THREE.Vector3[] = [];
    const minDist = 250;
    for (let i = 0; i < atomCount; i++) {
      let pos: THREE.Vector3;
      let attempts = 0;
      do {
        pos = new THREE.Vector3(
          (Math.random() - 0.5) * 900,
          (Math.random() - 0.5) * 600,
          (Math.random() - 0.5) * 300 - 50,
        );
        attempts++;
      } while (
        attempts < 50 &&
        atomPositions.some((p) => p.distanceTo(pos) < minDist)
      );
      atomPositions.push(pos);
    }

    const nucleusIndices: number[] = [];

    for (let i = 0; i < atomCount; i++) {
      const def = atomDefs[i % atomDefs.length];
      const basePos = atomPositions[i];

      // ── Nucleus ──
      const solidGeo = def.geo();
      const wireGeo = new THREE.EdgesGeometry(solidGeo);
      solidGeo.dispose();

      const t = i / Math.max(atomCount - 1, 1);
      const color = new THREE.Color().lerpColors(
        new THREE.Color(0.2, 1.8, 2.0),
        new THREE.Color(1.0, 0.5, 2.0),
        t,
      );

      const material = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.2,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });

      const mesh = new THREE.LineSegments(wireGeo, material);
      const scale =
        def.scaleRange[0] +
        Math.random() * (def.scaleRange[1] - def.scaleRange[0]);
      mesh.scale.setScalar(scale);
      mesh.position.copy(basePos);

      this.scene.add(mesh);

      const nucleusIdx = this.shapes.length;
      nucleusIndices.push(nucleusIdx);

      this.shapes.push({
        mesh,
        rotSpeed: new THREE.Vector3(
          (Math.random() - 0.5) * 0.04,
          (Math.random() - 0.5) * 0.04,
          (Math.random() - 0.5) * 0.02,
        ),
        basePosition: basePos.clone(),
        phase: Math.random() * Math.PI * 2,
        bobAmplitude: 8 + Math.random() * 12,
      });

      // ── Electron orbit rings ──
      for (let oi = 0; oi < def.orbits; oi++) {
        const orbitScale = scale * (1.3 + oi * 0.5);
        const ringGeo = this.createRingGeometry(64);

        const orbitColor = color.clone().multiplyScalar(0.7);
        const orbitMaterial = new THREE.LineBasicMaterial({
          color: orbitColor,
          transparent: true,
          opacity: 0.12,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });

        const orbitMesh = new THREE.LineSegments(ringGeo, orbitMaterial);
        orbitMesh.scale.setScalar(orbitScale);
        orbitMesh.position.copy(basePos);

        // Tilt each orbit to a unique axis
        orbitMesh.rotation.x = Math.random() * Math.PI;
        orbitMesh.rotation.y = Math.random() * Math.PI;

        this.scene.add(orbitMesh);

        this.shapes.push({
          mesh: orbitMesh,
          rotSpeed: new THREE.Vector3(
            (Math.random() - 0.5) * 0.3 + (oi === 0 ? 0.15 : -0.1),
            (Math.random() - 0.5) * 0.2,
            (Math.random() - 0.5) * 0.15,
          ),
          basePosition: basePos.clone(),
          phase: Math.random() * Math.PI * 2,
          bobAmplitude: 8 + Math.random() * 12,
          parentIdx: nucleusIdx,
        });
      }
    }

    // ── Chemical bonds between nearby atoms ──
    for (let i = 0; i < nucleusIndices.length; i++) {
      for (let j = i + 1; j < nucleusIndices.length; j++) {
        const dist = atomPositions[i].distanceTo(atomPositions[j]);
        if (dist > 500) continue;

        const geometry = new THREE.BufferGeometry();
        const positions = new Float32Array(6);
        geometry.setAttribute(
          "position",
          new THREE.BufferAttribute(positions, 3),
        );

        const bondT = (i + j) / (2 * Math.max(atomCount - 1, 1));
        const bondColor = new THREE.Color().lerpColors(
          new THREE.Color(0.15, 1.2, 1.5),
          new THREE.Color(0.6, 0.3, 1.2),
          bondT,
        );

        const lineMat = new THREE.LineBasicMaterial({
          color: bondColor,
          transparent: true,
          opacity: 0.06,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });

        const line = new THREE.Line(geometry, lineMat);
        this.scene.add(line);

        this.synapses.push({
          line,
          fromIdx: nucleusIndices[i],
          toIdx: nucleusIndices[j],
          flowPhase: Math.random() * Math.PI * 2,
          flowSpeed: 0.2 + Math.random() * 0.5,
        });
      }
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

    // Update molecular structure
    for (const shape of this.shapes) {
      shape.mesh.rotation.x += shape.rotSpeed.x * 0.016;
      shape.mesh.rotation.y += shape.rotSpeed.y * 0.016;
      shape.mesh.rotation.z += shape.rotSpeed.z * 0.016;

      if (shape.parentIdx !== undefined) {
        // Orbit ring: follow parent nucleus position
        const parent = this.shapes[shape.parentIdx];
        shape.mesh.position.copy(parent.mesh.position);

        // Subtle orbit shimmer
        const orbitPulse =
          0.08 + 0.06 * Math.sin(this.time * 1.2 + shape.phase);
        (shape.mesh.material as THREE.LineBasicMaterial).opacity = orbitPulse;
      } else {
        // Nucleus: gentle bobbing
        shape.mesh.position.x =
          shape.basePosition.x +
          Math.sin(this.time * 0.4 + shape.phase) * shape.bobAmplitude * 0.5;
        shape.mesh.position.y =
          shape.basePosition.y +
          Math.sin(this.time * 0.25 + shape.phase) * shape.bobAmplitude;

        // Nucleus pulse
        const pulse =
          0.15 + 0.1 * Math.sin(this.time * 0.6 + shape.phase);
        (shape.mesh.material as THREE.LineBasicMaterial).opacity = pulse;
      }
    }

    // Update chemical bonds
    for (const syn of this.synapses) {
      const fromPos = this.shapes[syn.fromIdx].mesh.position;
      const toPos = this.shapes[syn.toIdx].mesh.position;

      const posArr = (
        syn.line.geometry.attributes.position as THREE.BufferAttribute
      ).array as Float32Array;
      posArr[0] = fromPos.x;
      posArr[1] = fromPos.y;
      posArr[2] = fromPos.z;
      posArr[3] = toPos.x;
      posArr[4] = toPos.y;
      posArr[5] = toPos.z;
      (
        syn.line.geometry.attributes.position as THREE.BufferAttribute
      ).needsUpdate = true;

      // Bond energy pulse
      const flow =
        0.04 +
        0.06 * Math.max(0, Math.sin(this.time * syn.flowSpeed + syn.flowPhase));
      (syn.line.material as THREE.LineBasicMaterial).opacity = flow;
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
    for (const shape of this.shapes) {
      shape.mesh.geometry.dispose();
      (shape.mesh.material as THREE.Material).dispose();
    }
    for (const syn of this.synapses) {
      syn.line.geometry.dispose();
      (syn.line.material as THREE.Material).dispose();
    }
    this.composer.dispose();
    this.renderer.dispose();
  }
}
