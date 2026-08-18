import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  useImperativeHandle,
  forwardRef,
  CSSProperties,
} from "react";

/**
 * EnergyBackground
 * ------------------------------------------------------------------
 * A WebGL "cosmic energy" backdrop: silky ribbons of glowing plasma
 * drifting through a dark void, with blown-out hot cores and a star field.
 *
 * THEMING
 * Give it one colour and it derives the whole ramp:
 *
 *   <EnergyBackground themeColor="#ea0909" />
 *   <EnergyBackground themeColor="var(--theme-color)" />   // follows the CSS var live
 *   energy.current!.setTheme("#3cb87a");                   // imperative
 *
 * The derived ramp rotates hue and shifts lightness around the theme colour:
 *   accentColor       = hue-shifted + darker  (cool outer edge)
 *   concentratedColor = the theme colour      (ribbon body)
 *   coreColor         = desaturated + near-white (blown-out core)
 *   rippleColor       = light tint of the theme
 * Passing any of those props explicitly overrides that slot.
 *
 * When themeColor is a `var(...)`, a MutationObserver watches for inline style
 * changes on <html> and re-resolves, so a colour picker writing
 * `document.documentElement.style.setProperty("--theme-color", c)` is picked
 * up with no extra wiring.
 *
 * INTERACTION
 * Clicking emits a shockwave: an expanding ring that pushes the plasma
 * radially outward as it travels and fades over its lifetime. Ripples can also
 * be fired programmatically:
 *
 *   energy.current!.ripple("50%", "30%");   // percentages of the element
 *   energy.current!.ripple(120, 340);       // CSS pixels
 *   energy.current!.ripple();               // dead centre
 *
 * HOW THE RIBBON LOOK IS MADE
 * The density field is not plain fbm (that gives round blobs). Instead the
 * sample point is ADVECTED along a curl-noise velocity field over several
 * steps, accumulating ridged turbulence as it goes. Because successive
 * samples are dragged along the same streamlines, the result stretches into
 * long flow-aligned filaments. Ridged turbulence (1 - |noise|, sharpened)
 * then carves those into thin bright veins rather than soft clouds.
 *
 * PERFORMANCE
 * The GL context is built ONCE and every prop is streamed to it per frame via
 * a ref. That matters for theming specifically: a colour picker fires `input`
 * continuously while dragging, and rebuilding the context on each of those
 * would thrash. `pixelRatioCap` defaults to 1.25; `flowSteps` / `octaves` are
 * the quality dials for weak GPUs.
 * ------------------------------------------------------------------
 */

/**
 * Shader-side ripple slot count. Must match MAX_RIPPLES in the GLSL below.
 *
 * Raising this is close to free: the shader loop skips empty slots with an
 * early `continue`, so unused capacity costs almost nothing per fragment. The
 * number that matters is rippleDuration / beatInterval - a ripple holds a slot
 * only until it expires, so with enough slots nothing is ever evicted mid
 * flight and every beat can have its own wave.
 */
const MAX_RIPPLES = 16;

const VERTEX_SRC = `
attribute vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const FRAGMENT_SRC = `
precision highp float;

#define MAX_RIPPLES 16

uniform vec2  uResolution;
uniform float uTime;

uniform float uNoiseScale;
uniform float uSpeed;
uniform float uRiseSpeed;

uniform float uFlowStrength;     // how hard curl advection stretches ribbons
uniform float uFlowSteps;        // 1..4 advection steps actually used
uniform float uOctaves;          // 2..6 ridged octaves actually used

uniform float uThreshold;        // energy below this is crushed to pure void
uniform float uDensity;          // shifts the whole ramp brighter/darker
uniform float uContrast;         // sharpens ribbons vs haze
uniform float uCoreThreshold;    // where the blown-out white core kicks in
uniform float uGlow;             // soft bloom halo around the ribbons

uniform vec3  uBaseColor;
uniform float uBaseAlpha;
uniform vec3  uAccentColor;
uniform vec3  uConcentratedColor;
uniform vec3  uCoreColor;
uniform float uOpacity;

uniform float uStarAmount;
uniform float uStarDensity;
uniform float uStarBrightness;

// ---- shockwaves ----
uniform vec2  uRippleOrigins[MAX_RIPPLES];  // in st space (y-up, x scaled by aspect)
uniform float uRippleAges[MAX_RIPPLES];     // seconds since spawn; < 0.0 = empty slot
uniform float uRippleSpeed;      // st units per second the ring travels
uniform float uRippleWidth;      // thickness of the ring
uniform float uRippleStrength;   // how far the ring shoves the plasma outward
uniform float uRippleEnergy;     // how much brightness the ring injects
uniform float uRippleDuration;   // lifetime in seconds
uniform vec3  uRippleColor;
uniform float uRippleColorMix;   // 0..1 how strongly the ring tints the plasma

// ---------- Ashima 3D simplex noise ----------
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}

float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

// 2D curl of a noise field -> a divergence-free velocity field.
// Advecting along this is what turns blobs into flowing ribbons.
vec2 curl(vec2 p, float t) {
  float e = 0.12;
  float n1 = snoise(vec3(p.x, p.y + e, t));
  float n2 = snoise(vec3(p.x, p.y - e, t));
  float n3 = snoise(vec3(p.x + e, p.y, t));
  float n4 = snoise(vec3(p.x - e, p.y, t));
  return vec2(n1 - n2, -(n3 - n4)) / (2.0 * e);
}

// ridged turbulence: 1-|n| squared -> thin bright veins instead of soft clouds
float ridged(vec2 p, float t) {
  float sum = 0.0;
  float amp = 0.55;
  float freq = 1.0;
  float norm = 0.0;
  for (int i = 0; i < 6; i++) {
    if (float(i) >= uOctaves) break;
    float n = snoise(vec3(p * freq, t + float(i) * 2.7));
    n = 1.0 - abs(n);
    n = n * n;
    sum += amp * n;
    norm += amp;
    amp *= 0.55;
    freq *= 2.05;
  }
  return sum / max(norm, 0.0001);
}

// ---------- stars ----------
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float starField(vec2 uv, float t) {
  vec2 g  = uv * uStarDensity;
  vec2 id = floor(g);
  vec2 f  = fract(g) - 0.5;

  float h = hash21(id);
  float present = step(1.0 - uStarAmount, h);

  vec2 off = (vec2(hash21(id + 11.3), hash21(id + 27.7)) - 0.5) * 0.7;
  float d = length(f - off);

  float twinkle = 0.55 + 0.45 * sin(t * 2.4 + h * 42.0);
  float point = exp(-d * d * 260.0);

  return present * point * twinkle;
}

void main() {
  vec2 res = uResolution;
  vec2 st  = gl_FragCoord.xy / res.y;

  float t = uTime * uSpeed;

  // ---- accumulate shockwaves ----
  // Each ripple is a gaussian ring whose radius grows with age. It pushes the
  // plasma radially outward at the ring, and injects brightness there. Both
  // fall off as the ring expands and ages, so it dissipates naturally.
  vec2 rippleDisp = vec2(0.0);
  float rippleGlow = 0.0;

  for (int i = 0; i < MAX_RIPPLES; i++) {
    float age = uRippleAges[i];
    if (age < 0.0) continue;                 // empty slot

    vec2 delta = st - uRippleOrigins[i];
    float d = length(delta);
    float radius = age * uRippleSpeed;

    // gaussian ring centred on the travelling wavefront
    float x = (d - radius) / max(uRippleWidth, 0.0001);
    float ring = exp(-x * x);

    // fade with age, and thin out as the ring gets large (energy spreads
    // over a longer circumference, so any given point sees less of it)
    float life = clamp(1.0 - age / max(uRippleDuration, 0.0001), 0.0, 1.0);
    float spread = 1.0 / (1.0 + radius * 1.0);

    float amp = ring * life * spread;

    vec2 dirR = d > 0.0001 ? delta / d : vec2(0.0);
    rippleDisp += dirR * amp * uRippleStrength;
    rippleGlow += amp;
  }
  rippleGlow = clamp(rippleGlow, 0.0, 1.0);

  vec2 p = st * uNoiseScale;
  p.y -= uTime * uRiseSpeed;
  p += rippleDisp;                            // the wave shoves the field

  // ---- curl advection: drag the sample along streamlines, accumulating
  // ridged turbulence. This is what stretches the field into ribbons. ----
  vec2 fp = p;
  float energy = 0.0;
  float amp = 1.0;
  float norm = 0.0;
  for (int i = 0; i < 4; i++) {
    if (float(i) >= uFlowSteps) break;
    vec2 v = curl(fp * 0.6 + vec2(0.0, t * 0.4), t * 0.5);
    fp += v * uFlowStrength * 0.12;
    energy += amp * ridged(fp, t);
    norm += amp;
    amp *= 0.62;
  }
  energy /= max(norm, 0.0001);

  // the wavefront also lights the plasma up as it passes through
  energy += rippleGlow * uRippleEnergy;

  // Crush the low end to pure void. Ridged turbulence sits around ~0.48 on
  // average, so without this remap essentially every pixel clears the first
  // color stop and the frame fills edge to edge instead of leaving the black
  // negative space that the wisps need in order to read as wisps.
  energy = smoothstep(uThreshold, 1.0, clamp(energy, 0.0, 1.0));
  energy = clamp(pow(energy, max(uContrast, 0.01)) * uDensity, 0.0, 1.0);

  // ---- multi-stop color ramp: void -> accent edge -> body -> hot core ----
  vec3 color = uBaseColor;
  color = mix(color, uAccentColor,       smoothstep(0.02, 0.28, energy));
  color = mix(color, uConcentratedColor, smoothstep(0.30, 0.62, energy));
  color = mix(color, uCoreColor,         smoothstep(uCoreThreshold, 1.0, energy));

  // alpha: sharp ribbon body + a wide soft bloom halo around it
  float body = smoothstep(0.03, 0.45, energy);
  float halo = pow(energy, 0.55) * uGlow;
  float alpha = max(body, halo);
  alpha = mix(uBaseAlpha, 1.0, alpha);

  // stars, dimmed where the plasma is bright so they read as "behind" it
  float s = starField(st, uTime) * uStarBrightness * (1.0 - body * 0.85);
  color += vec3(0.75, 0.82, 1.0) * s;
  alpha = max(alpha, s);

  // the ring itself tints and glows, so the wavefront stays visible even
  // where it crosses empty void
  color = mix(color, uRippleColor, clamp(rippleGlow * uRippleColorMix, 0.0, 1.0));
  alpha = max(alpha, rippleGlow * uRippleColorMix);

  alpha = clamp(alpha * uOpacity, 0.0, 1.0);
  gl_FragColor = vec4(color, alpha);
}
`;

/* ============================ colour utilities ============================ */

type RGBA = [number, number, number, number];

/**
 * Parse a CSS colour into 0..1 RGBA. Handles #rgb, #rgba, #rrggbb, #rrggbbaa
 * and rgb()/rgba() - the latter matters because getComputedStyle hands back
 * `rgb(234, 9, 9)` rather than the hex you wrote.
 */
function parseColor(input: string): RGBA {
  const v = (input ?? "").trim();

  if (v.startsWith("rgb")) {
    const nums = v
      .slice(v.indexOf("(") + 1, v.lastIndexOf(")"))
      .split(/[,\s/]+/)
      .map((n) => parseFloat(n))
      .filter((n) => Number.isFinite(n));
    if (nums.length >= 3) {
      const a = nums.length >= 4 ? nums[3] : 1;
      return [nums[0] / 255, nums[1] / 255, nums[2] / 255, a > 1 ? a / 255 : a];
    }
    return [0, 0, 0, 1];
  }

  const clean = v.replace("#", "");
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 255;

  if (clean.length === 3 || clean.length === 4) {
    r = parseInt(clean[0] + clean[0], 16);
    g = parseInt(clean[1] + clean[1], 16);
    b = parseInt(clean[2] + clean[2], 16);
    a = clean.length === 4 ? parseInt(clean[3] + clean[3], 16) : 255;
  } else if (clean.length === 6 || clean.length === 8) {
    r = parseInt(clean.slice(0, 2), 16);
    g = parseInt(clean.slice(2, 4), 16);
    b = parseInt(clean.slice(4, 6), 16);
    a = clean.length === 8 ? parseInt(clean.slice(6, 8), 16) : 255;
  }

  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
    return [0, 0, 0, 1];
  }
  return [r / 255, g / 255, b / 255, a / 255];
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** RGB (0..1) -> HSL with h in degrees. */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;

  if (d === 0) return [0, 0, l];

  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;

  return [h * 360, s, l];
}

/** HSL (h in degrees) -> RGB 0..1. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = ((h % 360) + 360) % 360 / 360;
  if (s === 0) return [l, l, l];

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  const hue2rgb = (t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };

  return [hue2rgb(hh + 1 / 3), hue2rgb(hh), hue2rgb(hh - 1 / 3)];
}

interface Palette {
  accent: RGBA;
  concentrated: RGBA;
  core: RGBA;
  ripple: RGBA;
}

/**
 * Build a full plasma ramp from a single theme colour.
 *
 * The ramp varies by LIGHTNESS, not hue: accent is the theme colour darkened,
 * the body is the theme colour, and the core is the theme colour lifted toward
 * white. That keeps the backdrop reading as the colour you actually picked.
 *
 * Hue rotation is opt-in via `hueShift` and defaults to 0 for a reason: the
 * accent band covers by far the largest area of the frame (the low-energy
 * range, where most pixels land), so rotating its hue changes the perceived
 * colour of the whole backdrop. A -28 degree shift on cyan puts the accent at
 * 152 degrees, and the result reads as green even though the body is still
 * exactly cyan.
 *
 * Clamping the body's lightness is what stops a very dark or very pale theme
 * colour from collapsing the ramp into one flat tone.
 */
function derivePalette(theme: RGBA, hueShift: number, shade: number): Palette {
  const [h, s, l] = rgbToHsl(theme[0], theme[1], theme[2]);

  const bodyL = Math.min(Math.max(l, 0.38), 0.72);
  // accent is simply the body darkened; never let it reach pure black or it
  // stops being a colour at all
  const accentL = Math.max(bodyL * (1 - clamp01(shade)), 0.1);

  // Saturation is nudged UP as lightness drops, because a dark colour at the
  // same saturation reads as muddy grey rather than as a deep version of the
  // hue.
  const accent = hslToRgb(h + hueShift, clamp01(s * 1.1), accentL);
  const concentrated = hslToRgb(h, clamp01(s), bodyL);
  // the core keeps enough saturation to stay recognisably the theme hue
  // instead of blowing out to a neutral white
  const core = hslToRgb(h + hueShift * 0.25, clamp01(s * 0.5), 0.9);
  const ripple = hslToRgb(h, clamp01(s * 0.6), 0.85);

  return {
    accent: [accent[0], accent[1], accent[2], 1],
    concentrated: [concentrated[0], concentrated[1], concentrated[2], 1],
    core: [core[0], core[1], core[2], 1],
    // matches the hand-tuned ripple alpha the explicit default used
    ripple: [ripple[0], ripple[1], ripple[2], 0.29],
  };
}

/**
 * Resolve `var(--name)` / `var(--name, fallback)` against live computed style.
 * Anything else is returned untouched.
 */
function resolveCssColor(value: string, scope: HTMLElement | null): string {
  const v = (value ?? "").trim();
  if (!v.startsWith("var(")) return v;

  const inner = v.slice(4, v.lastIndexOf(")"));
  const comma = inner.indexOf(",");
  const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
  const fallback = comma === -1 ? "" : inner.slice(comma + 1).trim();

  const el = scope ?? document.documentElement;
  const got = getComputedStyle(el).getPropertyValue(name).trim();
  return got || fallback || "#ffffff";
}

/* ============================== shader plumbing =========================== */

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) {
    console.error("EnergyBackground: unable to create shader (context lost?)");
    return null;
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(
      "EnergyBackground: shader compile error:",
      gl.getShaderInfoLog(shader) || "(no log - context likely lost)"
    );
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

const UNIFORM_NAMES = [
  "uResolution", "uTime",
  "uNoiseScale", "uSpeed", "uRiseSpeed",
  "uFlowStrength", "uFlowSteps", "uOctaves",
  "uThreshold", "uDensity", "uContrast", "uCoreThreshold", "uGlow",
  "uBaseColor", "uBaseAlpha", "uAccentColor", "uConcentratedColor",
  "uCoreColor", "uOpacity",
  "uStarAmount", "uStarDensity", "uStarBrightness",
  "uRippleSpeed", "uRippleWidth", "uRippleStrength", "uRippleEnergy",
  "uRippleDuration", "uRippleColor", "uRippleColorMix",
] as const;

type UniformName = (typeof UNIFORM_NAMES)[number];
type UniformLocations = Record<UniformName, WebGLUniformLocation | null> & {
  uRippleOrigins: WebGLUniformLocation | null;
  uRippleAges: WebGLUniformLocation | null;
};

interface Ripple {
  /** origin in st space (x scaled by aspect, y-up), matching the shader */
  x: number;
  y: number;
  /** performance.now() timestamp at spawn */
  born: number;
}

/** Everything the render loop reads each frame. Lives in a ref so prop
 *  changes never rebuild the GL context. */
interface LiveState {
  noiseScale: number;
  speed: number;
  riseSpeed: number;
  flowStrength: number;
  flowSteps: number;
  octaves: number;
  threshold: number;
  density: number;
  contrast: number;
  coreThreshold: number;
  glow: number;
  opacity: number;
  starAmount: number;
  starDensity: number;
  starBrightness: number;
  rippleColorMix: number;
  rippleSpeed: number;
  rippleWidth: number;
  rippleStrength: number;
  rippleEnergy: number;
  rippleDuration: number;
  maxRipples: number;
  rippleOnClick: boolean;
  additive: boolean;
  pixelRatioCap: number;
  base: RGBA;
  accent: RGBA;
  concentrated: RGBA;
  core: RGBA;
  ripple: RGBA;
}

/**
 * A ripple coordinate. Accepts:
 *   number   -> CSS pixels from the element's top-left
 *   "50%"    -> percentage of the element's width (x) or height (y)
 *   "120px"  -> CSS pixels
 */
export type RippleCoord = number | string;

export interface EnergyBackgroundHandle {
  /**
   * Fire a shockwave at a point on the element.
   * Defaults to dead centre when called with no arguments.
   */
  ripple: (x?: RippleCoord, y?: RippleCoord) => void;
  /**
   * Override the theme colour imperatively. Takes precedence over the
   * `themeColor` prop until `setTheme(null)` clears it. Accepts any CSS
   * colour string, including `var(--something)`.
   */
  setTheme: (color: string | null) => void;
  /** The theme colour currently in effect, resolved to a real colour. */
  getTheme: () => string | null;
  /** Remove all in-flight ripples immediately. */
  clearRipples: () => void;
  /** How many ripples are currently alive. Handy for debugging. */
  getRippleCount: () => number;
}

function resolveCoord(value: RippleCoord, size: number): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : size / 2;
  }
  const s = String(value).trim();
  if (s.endsWith("%")) {
    const pct = parseFloat(s);
    return Number.isFinite(pct) ? (pct / 100) * size : size / 2;
  }
  const n = parseFloat(s); // handles "120px" and bare "120"
  return Number.isFinite(n) ? n : size / 2;
}

export interface EnergyBackgroundProps {
  /**
   * Single colour that drives the whole ramp. Accepts a hex/rgb string or
   * `var(--your-var)`, which is re-resolved live when the variable changes.
   * Individual colour props below override their slot.
   */
  themeColor?: string;
  /**
   * Degrees the accent hue rotates away from the theme hue. Defaults to 0,
   * meaning the backdrop is exactly the hue you picked, varied by lightness.
   *
   * Set a nonzero value for a two-tone, iridescent ramp - but note the accent
   * covers the largest area of the frame, so this shifts the PERCEIVED colour
   * of the whole backdrop, not just its edges. +/-20 is already a strong
   * effect; -28 on cyan reads as green.
   */
  themeHueShift?: number;
  /**
   * 0..1, how much darker the accent is than the body. 0 makes the backdrop
   * nearly flat in tone, higher values give deeper shadowed edges with the
   * bright ribbons standing out more. Default 0.55.
   */
  themeShade?: number;

  /** The empty void. Accepts alpha. Not derived from the theme. */
  baseColor?: string;
  /** Cooler outer edge of the wisps. Overrides the derived accent. */
  accentColor?: string;
  /** Dense body of the ribbons. Overrides the derived body colour. */
  concentratedColor?: string;
  /** Blown-out hot core. Overrides the derived core. */
  coreColor?: string;
  /** Colour of the shockwave front. Overrides the derived ripple tint. */
  rippleColor?: string;

  /** Spatial frequency of the plasma pattern. Lower = bigger, calmer forms. */
  noiseScale?: number;
  /** Animation speed of the underlying turbulence. */
  speed?: number;
  /** Upward drift speed. 0 disables the rise. */
  riseSpeed?: number;

  /** How hard curl advection stretches the field into ribbons. */
  flowStrength?: number;
  /** 1..4 advection steps. More = smoother ribbons but slower. Clamped. */
  flowSteps?: number;
  /** 2..6 ridged octaves. More = finer detail but slower. Clamped. */
  octaves?: number;

  /** 0..1. Energy below this is crushed to pure void. */
  threshold?: number;
  /** Shifts the whole ramp brighter/darker. */
  density?: number;
  /** Sharpens ribbons against the haze. >1 thins them. */
  contrast?: number;
  /** 0..1, where the blown-out core kicks in. Lower = more hot cores. */
  coreThreshold?: number;
  /** Soft bloom halo strength around the ribbons. */
  glow?: number;
  /** Overall opacity multiplier. */
  opacity?: number;

  /** 0..1, fraction of star cells that contain a star. 0 disables stars. */
  starAmount?: number;
  /** Star grid frequency - higher = more, smaller stars. */
  starDensity?: number;
  /** Star brightness. */
  starBrightness?: number;

  /** Master switch for click-to-ripple. Ref-fired ripples always work. */
  rippleOnClick?: boolean;
  /** 0..1, how strongly the wavefront tints the plasma it crosses. */
  rippleColorMix?: number;
  /** How fast the ring expands, in st units per second. */
  rippleSpeed?: number;
  /** Thickness of the ring. Larger = softer, more diffuse wave. */
  rippleWidth?: number;
  /** How far the wavefront shoves the plasma outward as it passes. */
  rippleStrength?: number;
  /** How much extra brightness the wavefront injects. */
  rippleEnergy?: number;
  /** Lifetime of a ripple in seconds. */
  rippleDuration?: number;
  /**
   * Max simultaneous ripples, 1..16. The oldest is recycled when exceeded,
   * which looks like a wave vanishing mid flight - so this wants to be at
   * least `rippleDuration` / shortest expected gap between ripples. At 2.4s
   * duration, 12 slots covers a ripple every 200ms (300 BPM).
   */
  maxRipples?: number;

  /** Additive blending - bright areas accumulate into glow. */
  additive?: boolean;
  /** Caps devicePixelRatio. This shader is heavy; default 1.25. */
  pixelRatioCap?: number;
  /** Whether the container itself intercepts pointer events. */
  interactive?: boolean;

  className?: string;
  style?: CSSProperties;
}

const EnergyBackground = forwardRef<
  EnergyBackgroundHandle,
  EnergyBackgroundProps
>(function EnergyBackground(
  {
    themeColor,
    themeHueShift = 0,
    themeShade = 0.55,

    baseColor = "#000000b5",
    accentColor,
    concentratedColor,
    coreColor,
    rippleColor,

    noiseScale = 0.7,
    speed = 0.05,
    riseSpeed = 0.01,

    flowStrength = 0.8,
    flowSteps = 4,
    octaves = 5,

    threshold = 0.33,
    density = 1.4,
    contrast = 3.6,
    coreThreshold = 0.72,
    glow = 0.25,
    opacity = 1.0,

    starAmount = 0.015,
    starDensity = 70,
    starBrightness = 0.9,

    rippleOnClick = true,
    rippleColorMix = 0.55,
    rippleSpeed = 0.55,
    rippleWidth = 0.08,
    rippleStrength = 0.35,
    rippleEnergy = 0.35,
    rippleDuration = 2.4,
    maxRipples = 12,

    additive = true,
    pixelRatioCap = 1.25,
    interactive = false,
    className,
    style,
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const ripplesRef = useRef<Ripple[]>([]);
  const resizeRef = useRef<(() => void) | null>(null);

  /** Imperative theme override from setTheme(), wins over the prop. */
  const [themeOverride, setThemeOverride] = useState<string | null>(null);
  /** The theme string after `var(...)` resolution. */
  const [resolvedTheme, setResolvedTheme] = useState<string | null>(null);

  const themeSource = themeOverride ?? themeColor ?? null;

  // Resolve the theme (following CSS vars) and keep following it.
  useEffect(() => {
    if (!themeSource) {
      setResolvedTheme(null);
      return;
    }

    const update = () =>
      setResolvedTheme(resolveCssColor(themeSource, containerRef.current));

    update();

    // A plain colour can't change underneath us; only a var can.
    if (!themeSource.trim().startsWith("var(")) return;

    // Colour pickers typically write the variable straight onto <html> via
    // style.setProperty, which fires no event. Watching the style attribute
    // is what lets the backdrop follow a live drag with no extra wiring.
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    return () => observer.disconnect();
  }, [themeSource]);

  /** Parsed colours, recomputed only when a colour input actually changes. */
  const palette = useMemo(() => {
    const derived = resolvedTheme
      ? derivePalette(parseColor(resolvedTheme), themeHueShift, themeShade)
      : null;

    return {
      base: parseColor(baseColor),
      accent: accentColor
        ? parseColor(accentColor)
        : derived?.accent ?? parseColor("#673cb8"),
      concentrated: concentratedColor
        ? parseColor(concentratedColor)
        : derived?.concentrated ?? parseColor("#865ff0"),
      core: coreColor
        ? parseColor(coreColor)
        : derived?.core ?? parseColor("#acb7ff"),
      ripple: rippleColor
        ? parseColor(rippleColor)
        : derived?.ripple ?? parseColor("#bfe4ff49"),
    };
  }, [
    resolvedTheme, themeHueShift, themeShade,
    baseColor, accentColor, concentratedColor, coreColor, rippleColor,
  ]);

  /**
   * Everything the render loop reads. Kept in a ref and refreshed after each
   * render so the GL context is built exactly once. Previously every one of
   * these was in the effect's dependency array, which meant a colour picker
   * dragging through hues tore down and rebuilt the whole context on every
   * `input` event.
   */
  const liveRef = useRef<LiveState>({
    noiseScale, speed, riseSpeed,
    flowStrength, flowSteps, octaves,
    threshold, density, contrast, coreThreshold, glow, opacity,
    starAmount, starDensity, starBrightness,
    rippleColorMix, rippleSpeed, rippleWidth, rippleStrength,
    rippleEnergy, rippleDuration, maxRipples, rippleOnClick,
    additive, pixelRatioCap,
    base: palette.base,
    accent: palette.accent,
    concentrated: palette.concentrated,
    core: palette.core,
    ripple: palette.ripple,
  });

  useLayoutEffect(() => {
    liveRef.current = {
      noiseScale, speed, riseSpeed,
      flowStrength, flowSteps, octaves,
      threshold, density, contrast, coreThreshold, glow, opacity,
      starAmount, starDensity, starBrightness,
      rippleColorMix, rippleSpeed, rippleWidth, rippleStrength,
      rippleEnergy, rippleDuration, maxRipples, rippleOnClick,
      additive, pixelRatioCap,
      base: palette.base,
      accent: palette.accent,
      concentrated: palette.concentrated,
      core: palette.core,
      ripple: palette.ripple,
    };
  });

  // devicePixelRatio cap feeds canvas sizing, so a change needs a re-measure
  useEffect(() => {
    resizeRef.current?.();
  }, [pixelRatioCap]);

  /** Spawn a ripple at a point given in ELEMENT-RELATIVE CSS px. */
  const spawnRippleAtPx = useCallback((pxX: number, pxY: number) => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.height <= 0) return;

    // match the shader's st space: gl_FragCoord.xy / res.y, y-up.
    // Both axes divide by HEIGHT - that's what keeps ripples circular
    // rather than stretched on a non-square element.
    const x = pxX / rect.height;
    const y = (rect.height - pxY) / rect.height;

    const list = ripplesRef.current;
    list.push({ x, y, born: performance.now() });

    const slots = Math.max(1, Math.min(MAX_RIPPLES, liveRef.current.maxRipples));
    while (list.length > slots) list.shift();
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      ripple: (x: RippleCoord = "50%", y: RippleCoord = "50%") => {
        const container = containerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        spawnRippleAtPx(
          resolveCoord(x, rect.width),
          resolveCoord(y, rect.height)
        );
      },
      setTheme: (color: string | null) => setThemeOverride(color),
      getTheme: () => resolvedTheme,
      clearRipples: () => {
        ripplesRef.current.length = 0;
      },
      getRippleCount: () => ripplesRef.current.length,
    }),
    [spawnRippleAtPx, resolvedTheme]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const gl = (canvas.getContext("webgl", {
      antialias: true,
      alpha: true,
      premultipliedAlpha: false,
    }) || canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    if (!gl) return;

    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
    const program = gl.createProgram();
    if (!vertexShader || !fragmentShader || !program) {
      // Context likely lost mid-setup. Bail out quietly rather than crashing.
      return;
    }
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error(
        "EnergyBackground: program link error:",
        gl.getProgramInfoLog(program) || "(no log - context likely lost)"
      );
      return;
    }
    gl.useProgram(program);
    gl.enable(gl.BLEND);

    // fullscreen triangle
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW
    );
    const aPosition = gl.getAttribLocation(program, "aPosition");
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

    const uniforms = UNIFORM_NAMES.reduce((acc, name) => {
      acc[name] = gl.getUniformLocation(program, name);
      return acc;
    }, {} as UniformLocations);
    // array uniforms are queried by their first element
    uniforms.uRippleOrigins = gl.getUniformLocation(program, "uRippleOrigins[0]");
    uniforms.uRippleAges = gl.getUniformLocation(program, "uRippleAges[0]");

    // reusable scratch buffers so we're not allocating every frame
    const originBuf = new Float32Array(MAX_RIPPLES * 2);
    const ageBuf = new Float32Array(MAX_RIPPLES);

    let width = 0;
    let height = 0;

    const resize = () => {
      const dpr = Math.min(
        window.devicePixelRatio || 1,
        liveRef.current.pixelRatioCap
      );
      const rect = container.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width * dpr));
      height = Math.max(1, Math.floor(rect.height * dpr));
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = rect.width + "px";
      canvas.style.height = rect.height + "px";
      gl.viewport(0, 0, width, height);
    };
    resizeRef.current = resize;

    const ro = new ResizeObserver(resize);
    ro.observe(container);
    resize();

    // Listened on window rather than the container: the backdrop is normally
    // pointer-events:none and sits behind real content, so container clicks
    // would never fire.
    const handlePointerDown = (e: PointerEvent) => {
      if (!liveRef.current.rippleOnClick) return;
      const rect = container.getBoundingClientRect();
      spawnRippleAtPx(e.clientX - rect.left, e.clientY - rect.top);
    };
    window.addEventListener("pointerdown", handlePointerDown, { passive: true });

    const start = performance.now();
    let lastAdditive: boolean | null = null;

    const render = (now: number) => {
      const t = (now - start) / 1000;
      const L = liveRef.current;

      // blend mode is cheap to set but not free; only touch it on change
      if (L.additive !== lastAdditive) {
        lastAdditive = L.additive;
        gl.blendFunc(gl.SRC_ALPHA, L.additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
      }

      // drop expired ripples, then pack the live ones into the uniform arrays
      const list = ripplesRef.current;
      for (let i = list.length - 1; i >= 0; i--) {
        if ((now - list[i].born) / 1000 > L.rippleDuration) list.splice(i, 1);
      }
      for (let i = 0; i < MAX_RIPPLES; i++) {
        const rip = list[i];
        if (rip) {
          originBuf[i * 2] = rip.x;
          originBuf[i * 2 + 1] = rip.y;
          ageBuf[i] = (now - rip.born) / 1000;
        } else {
          originBuf[i * 2] = 0;
          originBuf[i * 2 + 1] = 0;
          ageBuf[i] = -1; // empty slot; shader skips it
        }
      }

      gl.useProgram(program);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.uniform2f(uniforms.uResolution, width, height);
      gl.uniform1f(uniforms.uTime, t);

      gl.uniform1f(uniforms.uNoiseScale, L.noiseScale);
      gl.uniform1f(uniforms.uSpeed, L.speed);
      gl.uniform1f(uniforms.uRiseSpeed, L.riseSpeed);

      gl.uniform1f(uniforms.uFlowStrength, L.flowStrength);
      gl.uniform1f(uniforms.uFlowSteps, Math.max(1, Math.min(4, L.flowSteps)));
      gl.uniform1f(uniforms.uOctaves, Math.max(2, Math.min(6, L.octaves)));

      gl.uniform1f(uniforms.uThreshold, L.threshold);
      gl.uniform1f(uniforms.uDensity, L.density);
      gl.uniform1f(uniforms.uContrast, L.contrast);
      gl.uniform1f(uniforms.uCoreThreshold, L.coreThreshold);
      gl.uniform1f(uniforms.uGlow, L.glow);
      gl.uniform1f(uniforms.uOpacity, L.opacity);

      gl.uniform3f(uniforms.uBaseColor, L.base[0], L.base[1], L.base[2]);
      gl.uniform1f(uniforms.uBaseAlpha, L.base[3]);
      gl.uniform3f(uniforms.uAccentColor, L.accent[0], L.accent[1], L.accent[2]);
      gl.uniform3f(
        uniforms.uConcentratedColor,
        L.concentrated[0], L.concentrated[1], L.concentrated[2]
      );
      gl.uniform3f(uniforms.uCoreColor, L.core[0], L.core[1], L.core[2]);

      gl.uniform1f(uniforms.uStarAmount, L.starAmount);
      gl.uniform1f(uniforms.uStarDensity, L.starDensity);
      gl.uniform1f(uniforms.uStarBrightness, L.starBrightness);

      gl.uniform2fv(uniforms.uRippleOrigins, originBuf);
      gl.uniform1fv(uniforms.uRippleAges, ageBuf);
      gl.uniform1f(uniforms.uRippleSpeed, L.rippleSpeed);
      gl.uniform1f(uniforms.uRippleWidth, L.rippleWidth);
      gl.uniform1f(uniforms.uRippleStrength, L.rippleStrength);
      gl.uniform1f(uniforms.uRippleEnergy, L.rippleEnergy);
      gl.uniform1f(uniforms.uRippleDuration, L.rippleDuration);
      gl.uniform3f(
        uniforms.uRippleColor,
        L.ripple[0], L.ripple[1], L.ripple[2]
      );
      gl.uniform1f(uniforms.uRippleColorMix, L.rippleColorMix * L.ripple[3]);

      gl.drawArrays(gl.TRIANGLES, 0, 3);
      rafRef.current = requestAnimationFrame(render);
    };

    rafRef.current = requestAnimationFrame(render);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      resizeRef.current = null;
      window.removeEventListener("pointerdown", handlePointerDown);
      // Deliberately NOT force-losing the WebGL context here: loseContext()
      // is async, so under React Strict Mode's mount -> cleanup -> remount
      // the second mount can grab a context that's mid-loss, making every
      // shader compile fail with a null info log. The browser reclaims the
      // context on its own once the canvas is GC'd.
    };
  }, [spawnRippleAtPx]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        minHeight: "100%",
        overflow: "hidden",
        boxSizing: "border-box",
        pointerEvents: interactive ? "auto" : "none",
        background: baseColor,
        ...style,
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          inset: 0,
          display: "block",
          width: "100%",
          height: "100%",
          boxSizing: "border-box",
        }}
      />
    </div>
  );
});

export default EnergyBackground;