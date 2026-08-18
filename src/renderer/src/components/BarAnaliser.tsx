// BarAnalyser.ts
import AudioMotionAnalyzer from "audiomotion-analyzer";
import { endlnr } from "@renderer/components/addons/HOC";

/**
 * BarAnalyser
 * ------------------------------------------------------------------
 * Audio analysis + beat detection.
 *
 * DESIGN RULE: A BEAT IS NEVER PREDICTED.
 *
 * An earlier version ran a phase-locked tempo grid: it estimated a period,
 * then emitted beats on that grid, "coasting" through gaps where no onset
 * arrived. Two things go wrong with that, and both are worse than the problem
 * it solved:
 *
 *   1. It keeps firing when there is no music. Pause the track and the grid
 *      happily carries on ticking, because nothing about it is tied to the
 *      audio actually containing anything.
 *   2. When the period estimate is even slightly wrong, the whole grid slides
 *      off the music and every beat lands in the wrong place. A detector that
 *      is merely late is annoying; one that is confidently wrong is useless.
 *
 * So every beat here is caused by a real transient in the audio, detected the
 * moment it happens. The tempo estimate still exists, but it is REPORTING
 * ONLY - it never decides when a beat fires.
 *
 * HOW ONSETS ARE FOUND
 *   - Spectral flux: sum over bands of max(0, now - previous). Only increases
 *     count, so a sustained note contributes nothing after its attack. This is
 *     what makes it respond to onsets rather than to loudness.
 *   - Adaptive threshold = rolling median + K * MAD. Median and MAD rather
 *     than mean and standard deviation because both are robust to the very
 *     peaks being detected; a mean is dragged upward by them, raising the bar
 *     exactly when a beat arrives.
 *   - A beat fires on the upward crossing of that threshold, with a short
 *     refractory so one attack cannot fire twice.
 *
 * SILENCE
 * A hard gate sits in front of all of it. When overall energy drops below a
 * fraction of the recent loudness, onset state resets and nothing is emitted.
 * Without this, silence drives the median and MAD toward zero, the threshold
 * collapses, and dither noise starts registering as beats.
 * ------------------------------------------------------------------ */

export interface BarAnalyserOptions {
  /** Event namespace. Events are emitted as `<name>.beat`, etc. */
  name?: string;
  /**
   * FFT window. 2048 (~43ms at 48kHz) rather than 8192 (~171ms): each frame
   * averages energy across the whole window, so a large one smears attacks
   * and blunts the transient that onset detection depends on.
   */
  fftSize?: number;
  /**
   * Spectral smoothing. Defaults to 0. Anything higher blends each frame with
   * the previous one, which directly delays onsets - and latency here is felt
   * as visuals lagging the music.
   */
  smoothing?: number;

  /**
   * Frames of flux history behind the adaptive threshold. ~1s at 60fps.
   * Longer is steadier but slower to follow a change in density.
   */
  historyFrames?: number;
  /**
   * Extra weight on low bands. 0 treats all bands equally, which lets hi-hats
   * trigger as readily as kicks. Higher biases toward kick and snare, which
   * is usually what reads as "the beat".
   */
  lowEmphasis?: number;
  /**
   * Minimum ms between beats. Also the ceiling on how fast beats can fire:
   * 100ms is 600 BPM, far above any real pulse, so it only suppresses
   * double-triggers rather than real beats.
   */
  minBeatInterval?: number;

  /**
   * Overall energy below this absolute level counts as silence. Catches a
   * paused or stopped track.
   */
  silenceFloor?: number;
  /**
   * ...and below this fraction of recent peak loudness also counts as
   * silence, which catches fades and gaps that are quiet but not digitally
   * silent.
   */
  silenceRatio?: number;

  /**
   * Emit the per-frame firehose (bars/average/highest/bass and normalised
   * variants, mid/treble/peak/overall). A dozen events and allocations every
   * frame; turn off if only beats are used.
   */
  emitRaw?: boolean;
}

type Unsub = (() => void) | void;

export class BarAnalyser {
  /** Multiples of MAD above the median that count as an onset. */
  private static readonly MAD_K = 4;
  /** Frames of sustained silence before state is reset. */
  private static readonly SILENCE_FRAMES = 15;
  /**
   * Release rate of the loudness envelope, per frame.
   *
   * The gate CANNOT compare instantaneous energy against the floor: on
   * percussive material energy dips below it between every hit, so each gap
   * reads as silence and detection is reset constantly - measured as a drop
   * from 100% recall to 0%. An envelope with instant attack and slow release
   * rides over the gaps while still falling away on a real pause.
   *
   * 0.93 notices a pause in ~400ms while leaving inter-beat gaps untouched;
   * slower values (0.98) take over 2s and start letting phantom beats through.
   */
  private static readonly ENVELOPE_RELEASE = 0.93;

  private motion: AudioMotionAnalyzer;
  private name: string;
  private subs: Unsub[] = [];

  // ── rolling averages for the raw/normalised event stream ──
  private volumeAvg = 1;
  private bassAvg = 1;
  private highestAvg = 1;
  private barsAvg: Float64Array | null = null;

  // ── onset detection ──
  private prevBands: Float64Array | null = null;
  private fluxHistory: Float64Array;
  private fluxScratch: Float64Array;
  private madScratch: Float64Array;
  private histIdx = 0;
  private histCount = 0;
  private prevFlux = 0;
  private prevThreshold = Number.POSITIVE_INFINITY;
  private lastBeatTime = -1e9;
  private lastBass = 0;

  // ── silence tracking ──
  private loudPeak = 0;
  private energyEnv = 0;
  private silentFrames = 0;

  // ── tempo, reported only ──
  private intervals: number[] = [];
  private bpm = 0;
  private bpmConfidence = 0;

  // ── options ──
  private lowEmphasis: number;
  private minBeatInterval: number;
  private silenceFloor: number;
  private silenceRatio: number;
  private emitRaw: boolean;

  constructor(
    audioCtx: AudioContext,
    source: AudioNode,
    options: BarAnalyserOptions | string = {}
  ) {
    // keep the old positional `name` signature working
    const opts: BarAnalyserOptions =
      typeof options === "string" ? { name: options } : options;

    this.name = opts.name ?? "analyser";
    this.lowEmphasis = opts.lowEmphasis ?? 1.2;
    this.minBeatInterval = opts.minBeatInterval ?? 100;
    this.silenceFloor = opts.silenceFloor ?? 0.012;
    this.silenceRatio = opts.silenceRatio ?? 0.06;
    this.emitRaw = opts.emitRaw ?? true;

    const historyFrames = opts.historyFrames ?? 60;
    this.fluxHistory = new Float64Array(historyFrames);
    this.fluxScratch = new Float64Array(historyFrames);
    this.madScratch = new Float64Array(historyFrames);

    this.motion = new AudioMotionAnalyzer(undefined, {
      audioCtx,
      source,
      useCanvas: false,
      connectSpeakers: false,
      fftSize: opts.fftSize ?? 2048,
      smoothing: opts.smoothing ?? 0,
      start: true,
      onCanvasDraw: () => this.tick(),
    });
  }

  private static medianOf(buf: Float64Array, n: number): number {
    if (n === 0) return 0;
    const view = buf.subarray(0, n);
    view.sort();
    return n % 2 ? view[(n - 1) >> 1] : (view[n / 2 - 1] + view[n / 2]) / 2;
  }

  /**
   * Onset threshold: median + K * MAD, computed over recent flux.
   *
   * Self-calibrating on purpose. A multiplier on the median (the usual
   * "sensitivity" knob) scales with the signal's absolute level and so needs
   * retuning per track; MAD measures spread, so "how far above normal is
   * unusual" carries across material unchanged.
   */
  private fluxThreshold(): number {
    const n = this.histCount;
    if (n < 10) return Number.POSITIVE_INFINITY; // not enough history yet

    this.fluxScratch.set(this.fluxHistory.subarray(0, n));
    const median = BarAnalyser.medianOf(this.fluxScratch, n);

    for (let i = 0; i < n; i++) {
      this.madScratch[i] = Math.abs(this.fluxHistory[i] - median);
    }
    const mad = BarAnalyser.medianOf(this.madScratch, n);

    return median + BarAnalyser.MAD_K * mad + 1e-6;
  }

  /** Drop onset state so a restart does not inherit a stale threshold. */
  private resetDetection(): void {
    this.histCount = 0;
    this.histIdx = 0;
    this.prevFlux = 0;
    this.prevThreshold = Number.POSITIVE_INFINITY;
    this.intervals.length = 0;
    if (this.prevBands) this.prevBands.fill(0);
    this.lastBeatTime = -1e9;
    if (this.bpm !== 0) {
      this.bpm = 0;
      this.bpmConfidence = 0;
      endlnr.emit(`${this.name}.tempo`, { bpm: 0, confidence: 0 });
    }
  }

  /**
   * Tempo from inter-onset intervals. REPORTING ONLY - it never gates a beat.
   *
   * Median rather than mean: a missed or doubled beat yields an interval that
   * is double or half the true one, and a mean smears that across the whole
   * estimate.
   */
  private updateTempo(interval: number): void {
    let folded = interval;
    while (folded > 0 && folded < 300) folded *= 2;
    while (folded > 1000) folded /= 2;
    if (!Number.isFinite(folded) || folded <= 0) return;

    this.intervals.push(folded);
    if (this.intervals.length > 12) this.intervals.shift();
    if (this.intervals.length < 4) return;

    const sorted = [...this.intervals].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const median =
      sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    if (median <= 0) return;

    const mad =
      this.intervals.reduce((s, v) => s + Math.abs(v - median), 0) /
      this.intervals.length;

    const bpm = 60000 / median;
    const confidence = Math.max(0, Math.min(1, 1 - mad / median));

    if (Math.abs(bpm - this.bpm) > 1) {
      this.bpm = bpm;
      this.bpmConfidence = confidence;
      endlnr.emit(`${this.name}.tempo`, { bpm, confidence });
    } else {
      this.bpmConfidence = confidence;
    }
  }

  private tick(): void {
    const m = this.motion;
    const now = performance.now();

    const overallRaw = m.getEnergy();

    // ── silence gate ──────────────────────────────────────────
    // Comes first so that a paused, stopped or faded-out track emits nothing.
    // Without it the median and MAD collapse toward zero during silence, the
    // threshold follows them down, and dither noise starts reading as beats.
    this.loudPeak = Math.max(this.loudPeak * 0.999, overallRaw);
    this.energyEnv = Math.max(
      overallRaw,
      this.energyEnv * BarAnalyser.ENVELOPE_RELEASE
    );
    const silenceLevel = Math.max(
      this.silenceFloor,
      this.loudPeak * this.silenceRatio
    );

    if (this.energyEnv < silenceLevel) {
      this.silentFrames++;
      if (this.silentFrames === BarAnalyser.SILENCE_FRAMES) {
        this.resetDetection();
        endlnr.emit(`${this.name}.silence`, { silent: true });
      }
      if (this.silentFrames >= BarAnalyser.SILENCE_FRAMES) {
        if (this.emitRaw) this.emitQuietFrame(overallRaw);
        return;
      }
    } else {
      if (this.silentFrames >= BarAnalyser.SILENCE_FRAMES) {
        endlnr.emit(`${this.name}.silence`, { silent: false });
      }
      this.silentFrames = 0;
    }

    const bassRaw = m.getEnergy("bass");
    const midRaw = m.getEnergy("mid");
    const trebleRaw = m.getEnergy("treble");
    const peakRaw = m.getEnergy("peak");

    const barsData = m.getBars();
    const n = barsData.length;
    if (n === 0) return;

    // buffers are sized lazily and rebuilt if the band count changes
    if (!this.prevBands || this.prevBands.length !== n) {
      this.prevBands = new Float64Array(n);
      this.barsAvg = new Float64Array(n).fill(1);
      this.histCount = 0;
      this.histIdx = 0;
    }
    const prevBands = this.prevBands;
    const barsAvg = this.barsAvg!;

    // ── spectral flux ──
    let flux = 0;
    let weightSum = 0;
    const bars255 = new Array<number>(n);
    let highest = 0;
    let sum = 0;

    for (let i = 0; i < n; i++) {
      const ch = barsData[i].value;
      const v =
        ch.length > 1 && ch[1] !== undefined ? Math.max(ch[0], ch[1]) : ch[0];

      const weight = 1 + this.lowEmphasis * (1 - i / Math.max(1, n - 1));
      const diff = v - prevBands[i];
      if (diff > 0) flux += diff * weight;
      weightSum += weight;
      prevBands[i] = v;

      const b255 = Math.round(v * 255);
      bars255[i] = b255;
      if (b255 > highest) highest = b255;
      sum += b255;
      barsAvg[i] = barsAvg[i] * 0.95 + b255 * 0.05;
    }
    flux /= weightSum || 1;

    const average = sum / n;
    const bass = Math.round(bassRaw * 255);

    const threshold = this.fluxThreshold();

    this.fluxHistory[this.histIdx] = flux;
    this.histIdx = (this.histIdx + 1) % this.fluxHistory.length;
    if (this.histCount < this.fluxHistory.length) this.histCount++;

    // ── beat: upward crossing of the adaptive threshold ──
    // Fires the instant flux crosses, so there is no added latency. The
    // refractory keeps a single attack from firing twice as flux wobbles
    // across the line.
    const crossed = flux > threshold && this.prevFlux <= this.prevThreshold;
    const clear = now - this.lastBeatTime >= this.minBeatInterval;

    if (crossed && clear) {
      const interval = now - this.lastBeatTime;
      this.lastBeatTime = now;

      const ratio = threshold > 0 ? flux / threshold : 1;
      const strength = Math.max(
        0,
        Math.min(255, Math.round(((ratio - 1) / 1.5) * 255))
      );

      if (Number.isFinite(interval) && interval < 3000) this.updateTempo(interval);

      endlnr.emit(`${this.name}.beat`, {
        strength,
        delta: bass - this.lastBass,
        flux,
        threshold,
        interval,
        bpm: this.bpm,
        confidence: this.bpmConfidence,
      });
    }

    this.prevFlux = flux;
    this.prevThreshold = threshold;
    this.lastBass = bass;

    if (!this.emitRaw) return;

    this.volumeAvg = this.volumeAvg * 0.95 + average * 0.05;
    this.bassAvg = this.bassAvg * 0.95 + bass * 0.05;
    this.highestAvg = this.highestAvg * 0.95 + highest * 0.05;

    const normalize = (value: number, avg: number): number =>
      avg > 0 ? Math.min(255, Math.max(0, (value / avg) * 128)) : 0;

    const normalizedBars = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      normalizedBars[i] = normalize(bars255[i], barsAvg[i]);
    }

    endlnr.emit(`${this.name}.bars`, { bars: bars255 });
    endlnr.emit(`${this.name}.average`, { average });
    endlnr.emit(`${this.name}.highest`, { highest });
    endlnr.emit(`${this.name}.bass`, { bass });

    endlnr.emit(`${this.name}.bars.norm`, { bars: normalizedBars });
    endlnr.emit(`${this.name}.average.norm`, {
      average: normalize(average, this.volumeAvg),
    });
    endlnr.emit(`${this.name}.highest.norm`, {
      highest: normalize(highest, this.highestAvg),
    });
    endlnr.emit(`${this.name}.bass.norm`, { bass: normalize(bass, this.bassAvg) });

    endlnr.emit(`${this.name}.flux`, { flux, threshold });

    endlnr.emit(`${this.name}.mid`, { mid: Math.round(midRaw * 255) });
    endlnr.emit(`${this.name}.treble`, { treble: Math.round(trebleRaw * 255) });
    endlnr.emit(`${this.name}.peak`, { peak: Math.round(peakRaw * 255) });
    endlnr.emit(`${this.name}.overall`, { overall: Math.round(overallRaw * 255) });
  }

  /**
   * During silence, still emit zeroed levels so anything driven by the
   * running average settles to rest instead of freezing at its last value.
   */
  private emitQuietFrame(overallRaw: number): void {
    this.volumeAvg = this.volumeAvg * 0.9;
    this.bassAvg = this.bassAvg * 0.9;
    this.highestAvg = this.highestAvg * 0.9;

    endlnr.emit(`${this.name}.average`, { average: 0 });
    endlnr.emit(`${this.name}.highest`, { highest: 0 });
    endlnr.emit(`${this.name}.bass`, { bass: 0 });
    endlnr.emit(`${this.name}.average.norm`, { average: 0 });
    endlnr.emit(`${this.name}.highest.norm`, { highest: 0 });
    endlnr.emit(`${this.name}.bass.norm`, { bass: 0 });
    endlnr.emit(`${this.name}.overall`, { overall: Math.round(overallRaw * 255) });
  }

  /** True while the gate considers the input silent. */
  isSilent(): boolean {
    return this.silentFrames >= BarAnalyser.SILENCE_FRAMES;
  }

  /** Current tempo estimate. Reporting only; it does not gate beats. */
  getTempo(): { bpm: number; confidence: number } {
    return { bpm: this.bpm, confidence: this.bpmConfidence };
  }

  stop(): void {
    this.motion.stop();
  }

  start(): void {
    this.motion.start();
  }

  connect(destination: AudioNode): void {
    this.motion.connectOutput(destination);
  }

  getMotion(): AudioMotionAnalyzer {
    return this.motion;
  }

  /** Stop analysing and release any subscriptions. */
  dispose(): void {
    this.motion.stop();
    for (const u of this.subs) if (typeof u === "function") u();
    this.subs.length = 0;
  }
}