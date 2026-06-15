// AudioController.ts

import { endlnr } from "./addons/HOC";

export class AudioController {
  private audio: HTMLAudioElement;
    private name: string;
  constructor( audio?: HTMLAudioElement,name = `audio`) {
    this.audio = audio || new Audio();
    this.name = name;
    this.registerListeners();
    this.registerEmitters();
  }

  private registerListeners() {
    // --- playback control ---
    endlnr.on(`${this.name}.load`, ({ src }) => {
      this.audio.src = src;
      this.audio.load();
    });

    endlnr.on(`${this.name}.play`, ({}: {}) => {
      this.audio.play();
    });

    endlnr.on(`${this.name}.pause`, ({}: {}) => {
      this.audio.pause();
    });

    endlnr.on(`${this.name}.toggle`, ({}: {}) => {
      this.audio.paused ? this.audio.play() : this.audio.pause();
    });

    endlnr.on(`${this.name}.stop`, ({}: {}) => {
      this.audio.pause();
      this.audio.currentTime = 0;
    });

    // --- seeking ---
    endlnr.on(`${this.name}.seek`, ({ time }) => {
      this.audio.currentTime = time;
    });

    endlnr.on(`${this.name}.seek.percent`, ({ percent }) => {
      this.audio.currentTime = (percent / 100) * this.audio.duration;
    });

    // --- volume ---
    endlnr.on(`${this.name}.volume`, ({ volume }) => {
      // volume: 0.0 – 1.0
      this.audio.volume = Math.min(1, Math.max(0, volume));
    });

    endlnr.on(`${this.name}.mute`, ({}: {}) => {
      this.audio.muted = true;
    });

    endlnr.on(`${this.name}.unmute`, ({}: {}) => {
      this.audio.muted = false;
    });

    endlnr.on(`${this.name}.mute.toggle`, ({}: {}) => {
      this.audio.muted = !this.audio.muted;
    });

    // --- playback rate ---
    endlnr.on(`${this.name}.rate`, ({ rate }) => {
      this.audio.playbackRate = rate;
    });
  }

  private registerEmitters() {
    // --- state changes ---
    this.audio.addEventListener(`play`, () => {
      endlnr.emit(`${this.name}.state`, { state: `playing` });
    });

    this.audio.addEventListener(`pause`, () => {
      endlnr.emit(`${this.name}.state`, { state: `paused` });
    });

    this.audio.addEventListener(`ended`, () => {
      endlnr.emit(`${this.name}.state`, { state: `ended` });
      endlnr.emit(`${this.name}.ended`, {});
    });

    this.audio.addEventListener(`loadedmetadata`, () => {
      endlnr.emit(`${this.name}.metadata`, {
        duration: this.audio.duration,
        src: this.audio.src,
      });
    });

    // --- time update (throttled to ~4x/sec to avoid flooding) ---
    let lastEmit = 0;
    this.audio.addEventListener(`timeupdate`, () => {
      const now = performance.now();
      if (now - lastEmit < 250) return;
      lastEmit = now;

      endlnr.emit(`${this.name}.time`, {
        currentTime: this.audio.currentTime,
        duration: this.audio.duration,
        percent: (this.audio.currentTime / this.audio.duration) * 100,
      });
    });

    // --- volume / mute ---
    this.audio.addEventListener(`volumechange`, () => {
      endlnr.emit(`${this.name}.volume.state`, {
        volume: this.audio.volume,
        muted: this.audio.muted,
      });
    });

    // --- errors ---
    this.audio.addEventListener(`error`, () => {
      endlnr.emit(`${this.name}.error`, {
        code: this.audio.error?.code,
        message: this.audio.error?.message,
      });
    });
  }

  /** Expose the raw element for BarAnalyser wiring */
  getElement(): HTMLAudioElement {
    return this.audio;
  }

  destroy() {
    this.audio.pause();
    this.audio.src = ``;
  }
  load(src: string) {
    this.audio.src = src;
    this.audio.load();
  }
  play() {
    this.audio.play();
  }
  pause() {
    this.audio.pause();
  }

  repeat(value: boolean) {
    this.audio.loop = value;
  }
   
}