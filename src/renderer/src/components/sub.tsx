
import React, {
  createContext,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  FaHeadphones,
  FaPlay,
  FaPause,
  FaStepBackward,
  FaStepForward,
  FaVolumeUp,
  FaVolumeMute,
} from "react-icons/fa";
import { FaFolderOpen } from "react-icons/fa";

import { Div } from "./addons/ctsx";
import { TbRepeatOnce, TbRepeat } from "react-icons/tb";
import BaseHOC, { endlnr } from "./addons/HOC";

import { HiColorSwatch } from "react-icons/hi";

function ColorPickerButton() {
  function openPicker() {
    const input = document.createElement("input");
    input.type = "color";
    input.value = "#ea0909"; // default theme color
    input.style.display = "none";
    document.body.appendChild(input);

    input.addEventListener("input", (e) => {
      const color = (e.target as HTMLInputElement).value;
      document.documentElement.style.setProperty("--theme-color", color);
    });

    input.addEventListener("change", (e) => {
      const color = (e.target as HTMLInputElement).value;
      document.documentElement.style.setProperty("--theme-color", color);
      localStorage.setItem("void-theme-color", color);
      document.body.removeChild(input);
    });

    input.click();
  }

  return (
    <button className="ctrl-btn" onClick={openPicker} title="Theme color">
      <HiColorSwatch />
    </button>
  );
}

type ControlsContextType = {
  playing: boolean;
  muted: boolean;
  repeat: boolean;
  progress: number;
  duration: number;
  progressPercent: number;
  togglePlay: () => void;
  toggleMute: () => void;
  toggleRepeat: () => void;
  restartSong: () => void;
  forwardSong: () => void;
  fmt: (s: number) => string;
};

const ControlsContext =
  createContext<ControlsContextType | null>(null);

function useControls() {
  const ctx = useContext(ControlsContext);

  if (!ctx) {
    throw new Error(
      "useControls must be used inside ControlsProvider"
    );
  }

  return ctx;
}

function getAudio() {
  return document.getElementById(
    "audio"
  ) as HTMLAudioElement | null;
}

function ControlsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const audio = getAudio();

    if (!audio) return;

audio.loop = repeat;
  console.log("loop set to:", audio.loop); 
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTime = (e: Event) => {
  setProgress((e.target as HTMLAudioElement).currentTime);
};
    const onMeta = () =>
      setDuration(audio.duration);
    const onVolume = () =>
      setMuted(audio.muted);
    const onEnded = () =>
      setPlaying(false);

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener(
      "timeupdate",
      onTime
    );
    audio.addEventListener(
      "loadedmetadata",
      onMeta
    );
    audio.addEventListener(
      "volumechange",
      onVolume
    );
    audio.addEventListener(
      "ended",
      onEnded
    );
    const onSeeked = () => setProgress(audio.currentTime);
audio.addEventListener("seeked", onSeeked);

// cleanup:

    return () => {
audio.removeEventListener("seeked", onSeeked);
      audio.removeEventListener(
        "play",
        onPlay
      );
      audio.removeEventListener(
        "pause",
        onPause
      );
      audio.removeEventListener(
        "timeupdate",
        onTime
      );
      audio.removeEventListener(
        "loadedmetadata",
        onMeta
      );
      audio.removeEventListener(
        "volumechange",
        onVolume
      );
      audio.removeEventListener(
        "ended",
        onEnded
      );
    };
  }, [repeat]);

  useEffect(() => {
    const audio = getAudio();

    if (audio) {
      audio.loop = repeat;
    }
  }, [repeat]);

  function togglePlay() {
    const audio = getAudio();

    if (!audio) return;

    if (audio.paused) {
      audio.play();
    } else {
      audio.pause();
    }
  }

  function toggleMute() {
    const audio = getAudio();

    if (!audio) return;

    audio.muted = !audio.muted;
  }

  function toggleRepeat() {
  setRepeat(r => {
    console.log("repeat toggled to:", !r);
    return !r;
  });
}

  function restartSong() {
    const audio = getAudio();

    if (!audio) return;

    audio.currentTime = 0;
  }

  function forwardSong() {
    const audio = getAudio();

    if (!audio) return;

    audio.currentTime = audio.duration;
  }

  function fmt(seconds: number) {
    if (!seconds || Number.isNaN(seconds)) {
      return "0:00";
    }

    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60)
      .toString()
      .padStart(2, "0");

    return `${mins}:${secs}`;
  }

  const progressPercent =
    duration > 0
      ? (progress / duration) * 100
      : 0;

  return (
    <ControlsContext.Provider
      value={{
        playing,
        muted,
        repeat,
        progress,
        duration,
        progressPercent,
        togglePlay,
        toggleMute,
        toggleRepeat,
        restartSong,
        forwardSong,
        fmt,
      }}
    >
      {children}
    </ControlsContext.Provider>
  );
}
function SeekBar() {
  const {
    progressPercent,
  } = useControls();

  // in SeekBar, after setting audio.currentTime:

function seek(clientX: number, element: HTMLDivElement) {
  const audio = getAudio();
  if (!audio || !audio.duration || isNaN(audio.duration)) return;

  const rect = element.getBoundingClientRect();
  const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  audio.currentTime = percent * audio.duration;
}
  function handleMouseDown(
    e: React.MouseEvent<HTMLDivElement>
  ) {
    const bar = e.currentTarget;

    seek(
      e.clientX,
      bar
    );

    const move = (
      event: MouseEvent
    ) => {
      seek(
        event.clientX,
        bar
      );
    };

    const up = () => {
      window.removeEventListener(
        "mousemove",
        move
      );

      window.removeEventListener(
        "mouseup",
        up
      );
    };

    window.addEventListener(
      "mousemove",
      move
    );

    window.addEventListener(
      "mouseup",
      up
    );
  }

  return (
    <div
      className="seek-bar"
      onMouseDown={
        handleMouseDown
      }
    >
      <div
        className="seek-fill"
        style={{
          width: `${progressPercent}%`,
        }}
      />

      <div
        className="seek-thumb"
        style={{
          left: `${progressPercent}%`,
        }}
      />
    </div>
  );
}
function VolumeBar() {
  const [volume, setVolume] = useState(1);

  useEffect(() => {
    const audio = getAudio();
    if (!audio) return;
    const onVolume = () => setVolume(audio.muted ? 0 : audio.volume);
    audio.addEventListener("volumechange", onVolume);
    return () => audio.removeEventListener("volumechange", onVolume);
  }, []);

  function seek(clientX: number, element: HTMLDivElement) {
    const audio = getAudio();
    if (!audio) return;
    const rect = element.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    audio.volume = percent;
    audio.muted = false;
    setVolume(percent);
  }

  function handleMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    const bar = e.currentTarget;
    seek(e.clientX, bar);

    const move = (event: MouseEvent) => seek(event.clientX, bar);
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  return (
    <div className="volume-bar" onMouseDown={handleMouseDown}>
      <div className="volume-fill" style={{ width: `${volume * 100}%` }} />
      <div className="volume-thumb" style={{ left: `${volume * 100}%` }} />
    </div>
  );
}


function TimeDisplay() {
  const {
    progress,
    duration,
    fmt,
  } = useControls();

  return (
    <Div className="seek-time">
      <span>{fmt(progress)}</span>
      <span>{fmt(duration)}</span>
    </Div>
  );
}

function RepeatButton() {
  const { repeat, toggleRepeat } = useControls();

  return (
    <button
      className={`ctrl-btn ${repeat ? "active" : ""}`}
      onClick={toggleRepeat}
      title={repeat ? "Repeat On" : "Repeat Off"}
    >
      {repeat ? <TbRepeatOnce /> : <TbRepeat />}
    </button>
  );
}


function BackButton() {
  return (
    <button className="ctrl-btn" onClick={() => endlnr.emit("song.prev", {})}>
      <FaStepBackward />
    </button>
  );
}

function ForwardButton() {
  return (
    <button className="ctrl-btn" onClick={() => endlnr.emit("song.next", {})}>
      <FaStepForward />
    </button>
  );
}

function OpenFolderButton() {
  return (
    <button className="ctrl-btn" onClick={() => endlnr.emit("dialog.open-folder", {})}>
      <FaFolderOpen />
    </button>
  );
}

function PlayPauseButton() {
  const {
    playing,
    togglePlay,
  } = useControls();

  return (
    <button
      className="ctrl-btn play-btn"
      onClick={togglePlay}
    >
      {playing ? (
        <FaPause />
      ) : (
        <FaPlay />
      )}
    </button>
  );
}





function MuteButton() {
  const {
    muted,
    toggleMute,
  } = useControls();

  return (
    <button
      className={`ctrl-btn ${
        muted ? "active" : ""
      }`}
      onClick={toggleMute}
    >
      {muted ? (
        <FaVolumeMute />
      ) : (
        <FaVolumeUp />
      )}
    </button>
  );
}

function Controls() {
  return (
    <Div className="controls">
      <SeekBar />
      <TimeDisplay />
      <Div className="vc">
        <VolumeBar />
      </Div>
      <Div className="control-buttons">
        <OpenFolderButton />
        <RepeatButton />
        <BackButton />
        <PlayPauseButton />
        <ForwardButton />
        <MuteButton />
        <ColorPickerButton /> 
      </Div>
    </Div>
  );
}

export default function Sub() {
  const Name = new BaseHOC()
  useEffect(()=>{
    endlnr.on("song.loaded", ({ name }) => {Name.innerText(name)});
  })
  return (
    <Div className="song">
      <Div className="song-info">
        <Div
          className="song-circle"
          id="song-circle"
        >
          <FaHeadphones size="50%" />
        </Div>
        <Name._ className="song-name">...</Name._>
      </Div>

      <ControlsProvider>
        <Controls />
      </ControlsProvider>
    </Div>
  );
}

