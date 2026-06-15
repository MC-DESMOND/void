// boxm.ts
import { endlnr } from "./addons/HOC";
import { getCenter } from "./addons/anys";

// ── tune these ───────────────────────────────────────────────
const BEAT_SENSITIVITY = 1.15;  // how much above average to trigger
const RIPPLE_FADE      = 0.003; // fade speed per frame
const RIPPLE_MAX_OP    = 0.6;  // max ripple opacity
// const RIPPLE_CAP       = 18;    // max simultaneous ripples
const SCALE_BOOST      = 0.05; // app scale pulse amount
const CIRCLE_SCALE_BOOST = 0.1; // app scale pulse amount
const ROTATION_BOOST   = 6;    // max rotation speed multiplier
// ────────────────────────────────────────────────────────────

export function initCirclePulse() {
  const circle = document.getElementById("song-circle") as HTMLElement;
  if (!circle) return;

  const anim = circle.animate(
    [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
    { duration: 20000, iterations: Infinity, easing: "linear" }
  );

  endlnr.on("analyser.beat", ({ strength }) => {
    const intensity = strength / 255;

    // scale pulse
    circle.style.scale = `${1 + intensity * 0.3}`;
    setTimeout(() => { circle.style.scale = "1"; }, 150);

    // rotation speedup
    const boost = 1 + intensity * ROTATION_BOOST;
    anim.playbackRate = boost;

    setTimeout(() => {
      const steps = 20;
      const stepTime = 600 / steps;
      let step = 0;
      const ease = setInterval(() => {
        step++;
        anim.playbackRate = boost + (1 - boost) * (step / steps);
        if (step >= steps) {
          anim.playbackRate = 1;
          clearInterval(ease);
        }
      }, stepTime);
    }, 150);
  });
}

export default function boxesManipulator() {
  // wire sensitivity to BarAnalyser
  endlnr.emit("analyser.sensitivity", { value: BEAT_SENSITIVITY });

  interface Ripple {
    radius: number;
    opacity: number;
    speed: number;
  }

  const ripples: Ripple[] = [];

  endlnr.on("analyser.beat", ({ strength }) => {
    const intensity = strength / 255;

    // cap simultaneous ripples
    // if (ripples.length < RIPPLE_CAP) {
      ripples.push({
        radius:  10,
        opacity: intensity * RIPPLE_MAX_OP,
        speed:   3 + intensity * 6,
      });
    // }

    // subtle app scale pulse
    const app = document.getElementById("app") as HTMLElement;
    if (app) {
      app.style.scale = `${1 + intensity * SCALE_BOOST}`;
      setTimeout(() => { app.style.scale = "1"; }, 100);
    }
  });

  endlnr.on("analyser.average.norm",({average})=>{
    let ave = average/255
    let circle:any 
    // circle = document.querySelector(".song-circle")
    if (circle){circle.style.scale = `${1 + ave * CIRCLE_SCALE_BOOST}`
    setTimeout(() => { circle.style.scale = "1"; }, 100);}
  })

  function animate() {
    const boxes = document.querySelector(".boxes-glow") as HTMLElement;
    if (!boxes) { requestAnimationFrame(animate); return; }

    const color = getComputedStyle(boxes)
      .getPropertyValue("--ripple-color")
      .trim() || "rgb(255, 255, 255)";

    const withOpacity = (opacity: number) =>
      `color-mix(in srgb, ${color} ${(opacity * 100).toFixed(1)}%, transparent)`;

    // advance ripples
    for (const r of ripples) {
      r.radius  += r.speed;
      r.opacity -= RIPPLE_FADE;
    }

    // remove dead ripples
    const maxRadius = Math.hypot(window.innerWidth, window.innerHeight);
    const alive = ripples.filter(r => r.opacity > 0 && r.radius < maxRadius);
    ripples.length = 0;
    ripples.push(...alive);

    if (ripples.length === 0) {
      boxes.style.background = "transparent";
    } else {
      // calculate center once per frame
      const center   = getCenter(".song-circle");
      const percentX = (center.x / window.innerWidth)  * 100;
      const percentY = (center.y / window.innerHeight) * 100;

      boxes.style.background = ripples
        .map(r => {
          const width = 30;
          const inner = Math.max(0, r.radius - width);
          const outer = r.radius + width;
          return `radial-gradient(circle at ${percentX}% ${percentY}%, transparent ${inner}px, ${withOpacity(r.opacity)} ${r.radius}px, transparent ${outer}px)`;
        })
        .join(", ");
    }

    requestAnimationFrame(animate);
  }

  animate();
}