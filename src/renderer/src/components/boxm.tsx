// boxm.ts
import type { RefObject } from "react";
import { endlnr } from "./addons/HOC";
import { getCenter } from "./addons/anys";
import type { EnergyBackgroundHandle } from "./energy";

/**
 * Beat-reactive visuals.
 *
 * The old version drew ripples itself: it kept an array of {radius, opacity},
 * advanced them on a requestAnimationFrame loop, and rebuilt a stacked
 * `radial-gradient(...)` background string on `.boxes-glow` every single frame.
 * That is a per-frame string concat plus a full style recalc and repaint of a
 * viewport-sized element, on the main thread, competing with the audio
 * analyser.
 *
 * EnergyBackground now does the same thing on the GPU, so all of that is gone.
 * This module's job is reduced to deciding WHEN and WHERE a ripple happens and
 * calling `energy.ripple(x, y)`.
 * ------------------------------------------------------------------ */

// ── tune these ───────────────────────────────────────────────
const BEAT_SENSITIVITY = 1;   // how much above average counts as a beat

/** Ignore beats weaker than this (0..1). Stops quiet passages from
 *  machine-gunning ripples that are too faint to see anyway. */
const BEAT_FLOOR = 0.18;

/** Minimum ms between ripples. The shader holds a limited number of slots
 *  (maxRipples), so firing on every single beat just recycles them before
 *  they've visibly expanded - you get flicker instead of waves. */
const MIN_RIPPLE_INTERVAL = 110;

/** Above this intensity, fire a second offset ripple so big hits read as
 *  bigger rather than just identical. */
// const DOUBLE_RIPPLE_AT = 0.72;

/** Random spread (in % of the element) applied to each ripple origin, so
 *  repeated beats don't stack perfectly on top of each other. */
const ORIGIN_JITTER = 7;

/** Element whose centre ripples emanate from. Falls back to screen centre. */
const ORIGIN_SELECTOR = ".song-circle";

// const SCALE_BOOST = 0.02;         // app scale pulse amount
// const SCALE_HOLD = 100;          // ms before the pulse relaxes
const CIRCLE_SCALE_BOOST = 0.1;  // idle circle breathing amount
const ROTATION_BOOST = 6;        // max rotation speed multiplier
// ────────────────────────────────────────────────────────────

type Unsub = (() => void) | void;

/** endlnr.on may or may not hand back an unsubscribe. Capture whatever it
 *  returns and only call it if it turned out to be callable. */
function subscribe(
  event: string,
  handler: (payload: any) => void,
  bag: Unsub[]
): void {
  bag.push(endlnr.on(event, handler) as unknown as Unsub);
}

function disposeAll(bag: Unsub[]): void {
  for (const u of bag) {
    if (typeof u === "function") u();
  }
  bag.length = 0;
}

export function initCirclePulse(): () => void {
  const circle = document.getElementById("song-circle");
  if (!circle) return () => {};

  const anim = circle.animate(
    [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
    { duration: 20000, iterations: Infinity, easing: "linear" }
  );

  const timers: number[] = [];
  const subs: Unsub[] = [];

  subscribe(
    "analyser.beat",
    ({ strength }: { strength: number }) => {
      const intensity = strength / 255;

      circle.style.scale = `${1 + intensity * 0.3}`;
      timers.push(
        window.setTimeout(() => {
          circle.style.scale = "1";
        }, 150)
      );

      const boost = 1 + intensity * ROTATION_BOOST;
      anim.playbackRate = boost;

      timers.push(
        window.setTimeout(() => {
          const steps = 20;
          const stepTime = 600 / steps;
          let step = 0;
          const ease = window.setInterval(() => {
            step++;
            anim.playbackRate = boost + (1 - boost) * (step / steps);
            if (step >= steps) {
              anim.playbackRate = 1;
              window.clearInterval(ease);
            }
          }, stepTime);
          timers.push(ease);
        }, 150)
      );
    },
    subs
  );

  return () => {
    disposeAll(subs);
    timers.forEach((t) => window.clearTimeout(t));
    anim.cancel();
  };
}

/**
 * Wire beat events to the energy backdrop.
 *
 * @param energyRef ref to the EnergyBackground handle. Passed as a ref rather
 *        than the handle itself because this runs from an effect that may fire
 *        before the child has attached its ref - reading `.current` lazily at
 *        beat time avoids capturing a null.
 * @returns a disposer. Call it from your effect cleanup.
 */
export default function boxesManipulator(
  energyRef?: RefObject<EnergyBackgroundHandle | null>
): () => void {
  const subs: Unsub[] = [];
  const timers: number[] = [];

  // tell BarAnalyser how twitchy to be
  endlnr.emit("analyser.sensitivity", { value: BEAT_SENSITIVITY });

  let lastRippleAt = 0;

  /**
   * Where a ripple should originate, as percentages of the backdrop element.
   *
   * EnergyBackground resolves "x%" against its own width and "y%" against its
   * own height, and it's absolutely positioned to fill #app - so percentages
   * are computed against #app's box, not the viewport. Those are usually the
   * same thing here, but not if #app is ever inset or scaled (and it IS
   * scaled, by the beat pulse below).
   */
  function originPercent(): { x: number; y: number } {
    const host = document.getElementById("app");
    const rect = host?.getBoundingClientRect();
    const w = rect?.width || window.innerWidth;
    const h = rect?.height || window.innerHeight;
    const left = rect?.left ?? 0;
    const top = rect?.top ?? 0;

    let cx = left + w / 2;
    let cy = top + h / 2;

    // getCenter throws if the selector matches nothing, which is normal
    // before a song is loaded - fall back to the middle rather than dying.
    try {
      const c = getCenter(ORIGIN_SELECTOR);
      if (c && Number.isFinite(c.x) && Number.isFinite(c.y)) {
        cx = c.x;
        cy = c.y;
      }
    } catch {
      /* no origin element yet; centre is fine */
    }

    return {
      x: ((cx - left) / w) * 100,
      y: ((cy - top) / h) * 100,
    };
  }

  function jitter(v: number): number {
    return v + (Math.random() - 0.5) * 2 * ORIGIN_JITTER;
  }

  function fireRipple(_intensity: number): void {
    const energy = energyRef?.current;
    if (!energy) return;

    const now = performance.now();
    if (now - lastRippleAt < MIN_RIPPLE_INTERVAL) return;
    lastRippleAt = now;

    const { x, y } = originPercent();
    energy.ripple(`${jitter(x)}%`, `${jitter(y)}%`);

    // big hits get a second, wider-offset wave so they feel heavier
    /* if (intensity >= DOUBLE_RIPPLE_AT) {
      const spread = ORIGIN_JITTER * 2.5;
      energy.ripple(
        `${x + (Math.random() - 0.5) * 2 * spread}%`,
        `${y + (Math.random() - 0.5) * 2 * spread}%`
      );
    } */
  }

  // ── beat: ripple + app pulse ──────────────────────────────
  let pulseTimer = 0;

  subscribe(
    "analyser.beat",
    ({ strength }: { strength: number }) => {
      const intensity = Math.min(Math.max(strength / 255, 0), 1);
      if (intensity < BEAT_FLOOR) return;

      fireRipple(intensity);

      /* const app = document.getElementById("app");
      if (app) {
        window.clearTimeout(pulseTimer);
        app.style.scale = `${1 + intensity * SCALE_BOOST}`;
        // one shared timer instead of a new setTimeout per beat: rapid beats
        // used to queue overlapping timeouts that reset the scale mid-pulse
        pulseTimer = window.setTimeout(() => {
          app.style.scale = "1";
        }, SCALE_HOLD);
        timers.push(pulseTimer);
      } */
    },
    subs
  );

  // ── running average: gentle idle breathing on the circle ──
  subscribe(
    "analyser.average.norm",
    ({ average }: { average: number }) => {
      // The old version declared `let circle: any` and never assigned it, so
      // the `if (circle)` below was permanently false and this handler did
      // nothing at all. Actually querying the element makes it work.
      const circle = document.querySelector<HTMLElement>(ORIGIN_SELECTOR);
      if (!circle) return;

      const ave = Math.min(Math.max(average / 255, 0), 1);
      circle.style.scale = `${1 + ave * CIRCLE_SCALE_BOOST}`;
    },
    subs
  );

  return () => {
    disposeAll(subs);
    timers.forEach((t) => window.clearTimeout(t));
    window.clearTimeout(pulseTimer);

    const app = document.getElementById("app");
    if (app) app.style.scale = "1";
  };
}