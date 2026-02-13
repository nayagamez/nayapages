import "./style.css";
import { ParticleField } from "./background/ParticleField";

function init(): void {
  const canvas = document.getElementById("bg-canvas") as HTMLCanvasElement;
  if (!canvas) return;

  // Initialize 3D background (always animate — it's the core visual)
  new ParticleField({ canvas });

  // Scroll-triggered fade-in animations
  const reducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  const fadeElements = document.querySelectorAll(".fade-in");
  if (fadeElements.length > 0 && !reducedMotion) {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("visible");
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.15 },
    );

    for (const el of fadeElements) {
      observer.observe(el);
    }
  } else {
    // If reduced motion or no elements, show everything immediately
    for (const el of fadeElements) {
      el.classList.add("visible");
    }
  }
}

init();
