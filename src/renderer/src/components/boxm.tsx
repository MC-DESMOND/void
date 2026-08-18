// boxm.ts
import type { RefObject } from "react";
import { endlnr } from "./addons/HOC";
import { getCenter } from "./addons/anys";
import type { EnergyBackgroundHandle } from "./energy";

/**
 * Beat-reactive visuals.
 *
 * WHAT THIS NO LONGER DOES
 *
 * 1. It does not draw ripples. It used to keep an array of {radius, opacity},
 *    advance them on a rAF loop, and rebuild a stacked `radial-gradient(...)`
 *    string on `.boxes-glow` every frame - a per-frame string concat plus a
 *    full style recalc and repaint of a viewport-sized element, on the main
 *    thread, competing with the audio analyser. EnergyBackground does it on
 *    the GPU now.
 *
 * 2. It does not set a beat SENSITIVITY. The analyser calibrates its own
 *    onset threshold from the running median and MAD of spectral flux, and
 *    then filters onsets through a phase-locked tempo grid. Feeding it a
 *    magic multiplier had no measurable effect on which beats came out.
 *
 * 3. It does not rate-limit ripples. See DOUBLE_FIRE_GUARD_MS below.
 *
 * 4. It does not apply a beat FLOOR. That gate existed because the old
 *    detector emitted a lot of junk during quiet passages and the strength
 *    value was the only way to sift it. Beats now arrive on a tracked grid,
 *    so a quiet beat is still a beat - dropping it just punched holes in the
 *    rhythm. Strength still modulates how the ripple LOOKS, it just no longer
 *    decides whether one happens.
 *
 * All this module does now is decide WHERE a ripple goes and call
 * `energy.ripple(x, y)`.
 * ------------------------------------------------------------------ */

/** Random spread (in % of the element) applied to each ripple origin, so
 *  repeated beats don't stack perfectly on top of each other. */
const ORIGIN_JITTER = 7;

/** Element ripples emanate from. Falls back to the centre of the backdrop. */
const ORIGIN_SELECTOR = ".song-circle";

/**
 * EVERY beat gets a ripple. There is no rate limit any more.
 *
 * There used to be one, derived from the shader's ripple capacity: with 5
 * slots over a 2.4s lifetime a ripple could only start every 480ms, so faster
 * beats were dropped. That threw away real beats - at 140 BPM (428ms apart)
 * it silently skipped every other one.
 *
 * The fix belongs on the capacity side, not here. A ripple only holds a slot
 * until it expires, so as long as `rippleDuration / beatInterval` is under the
 * slot count nothing is ever evicted mid flight. EnergyBackground now defaults
 * to 16 slots, which at a 2.4s duration covers a beat every 150ms (400 BPM) -
 * comfortably past anything musical.
 *
 * The only guard left is against a pathological double-fire in the same
 * animation frame, which is a bug shield rather than a musical decision.
 */
const DOUBLE_FIRE_GUARD_MS = 40;

/** Idle circle breathing amount, driven by the running average. */
const CIRCLE_SCALE_BOOST = 0.1;
/** Max rotation speed multiplier on a beat. */
const ROTATION_BOOST = 6;

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
      const intensity = Math.min(Math.max(strength / 255, 0), 1);

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

  let lastRippleAt = 0;

  /**
   * Where a ripple should originate, as percentages of the backdrop element.
   *
   * EnergyBackground resolves "x%" against its own width and "y%" against its
   * own height, and it is absolutely positioned to fill #app - so percentages
   * are computed against #app's box, not the viewport. Those are usually the
   * same, but not if #app is ever inset or scaled.
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

  // ── beat -> ripple ────────────────────────────────────────
  subscribe(
    "analyser.beat",
    () => {
      const energy = energyRef?.current;
      if (!energy) return;

      const now = performance.now();
      if (now - lastRippleAt < DOUBLE_FIRE_GUARD_MS) return;
      lastRippleAt = now;

      const { x, y } = originPercent();
      energy.ripple(`${jitter(x)}%`, `${jitter(y)}%`);
    },
    subs
  );

  // ── running average: gentle idle breathing on the circle ──
  subscribe(
    "analyser.average.norm",
    ({ average }: { average: number }) => {
      const circle = document.querySelector<HTMLElement>(ORIGIN_SELECTOR);
      if (!circle) return;

      const ave = Math.min(Math.max(average / 255, 0), 1);
      circle.style.scale = `${1 + ave * CIRCLE_SCALE_BOOST}`;
    },
    subs
  );

  return () => {
    disposeAll(subs);
    const app = document.getElementById("app");
    if (app) app.style.scale = "1";
  };
}