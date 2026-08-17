import { useCallback, useEffect, useRef } from "react";
import { BarAnalyser } from "./components/BarAnaliser";
import { Button, Div, Main } from "./components/addons/ctsx";
import { endlnr, enddata } from "./components/addons/HOC";
import boxesManipulator from "./components/boxm";
import Bars from "./components/Bars";
import Sub from "./components/sub";
import { FaRegFolderOpen } from "react-icons/fa6";
import { AudioOutputWatcher } from "./components/AudioOutputWatcher";
import EnergyBackground, {
  type EnergyBackgroundHandle,
} from "./components/energy";

interface ElectronAPI {
  readFile(path: string): Promise<ArrayBuffer | Uint8Array>;
  openDialog(): Promise<string[]>;
  openFolder(): Promise<string[]>;
  onOpenFiles(
    cb: (payload: { files: string[]; startIndex: number }) => void
  ): void;
}

const electronAPI = (window as unknown as { electronAPI: ElectronAPI })
  .electronAPI;

type Unsub = (() => void) | void;

/** endlnr.on may or may not return an unsubscribe; only call it if callable. */
function subscribe(
  event: string,
  handler: (payload: any) => void,
  bag: Unsub[]
): void {
  bag.push(endlnr.on(event, handler) as unknown as Unsub);
}

/** Strip directories and extension. Handles both \ and / so this doesn't
 *  break the moment the app runs anywhere other than Windows. */
function prettyName(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? "";
  return base.replace(/\.[^.]+$/, "") || "Unknown";
}

function App(): React.JSX.Element {
  const bootstrapped = useRef(false);

  const audioRef = useRef<HTMLAudioElement>(null);
  const energyBackground = useRef<EnergyBackgroundHandle>(null);

  const queue = useRef<string[]>([]);
  const queueIndex = useRef(0);

  /** Blob URL currently assigned to the <audio> element. Held so it can be
   *  revoked when replaced. Without this every track load leaks its decoded
   *  file for the lifetime of the app - on a long listening session with
   *  multi-MB files that adds up fast. */
  const blobUrlRef = useRef<string | null>(null);

  const loadFile = useCallback(async (filePath: string) => {
    const audioElement = audioRef.current;
    if (!audioElement) return;

    try {
      const buffer = await electronAPI.readFile(filePath);
      const blob = new Blob([buffer as BlobPart], { type: "audio/mpeg" });
      const blobUrl = URL.createObjectURL(blob);

      // release the previous track's URL before overwriting the reference
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = blobUrl;

      endlnr.emit("song.loaded", { name: prettyName(filePath) });

      audioElement.src = blobUrl;
      audioElement.load();

      // play() rejects on autoplay policy or if load() interrupts it. Left
      // unhandled this shows up as an uncaught promise rejection rather than
      // anything actionable.
      await audioElement.play().catch((err) => {
        console.warn("playback did not start:", err);
      });
    } catch (err) {
      console.error("failed to load", filePath, err);
    }
  }, []);

  const nextSong = useCallback(() => {
    if (queue.current.length === 0) return;
    queueIndex.current = (queueIndex.current + 1) % queue.current.length;
    loadFile(queue.current[queueIndex.current]);
  }, [loadFile]);

  const prevSong = useCallback(() => {
    if (queue.current.length === 0) return;
    queueIndex.current =
      (queueIndex.current - 1 + queue.current.length) % queue.current.length;
    loadFile(queue.current[queueIndex.current]);
  }, [loadFile]);

  const openDialog = useCallback(async () => {
    const paths = await electronAPI.openDialog();
    if (paths.length > 0) {
      queue.current = paths;
      queueIndex.current = 0;
      loadFile(paths[0]);
    }
  }, [loadFile]);

  const openFolder = useCallback(async () => {
    const paths = await electronAPI.openFolder();
    if (paths.length === 0) return;
    queue.current = paths;
    queueIndex.current = 0;
    loadFile(paths[0]);
  }, [loadFile]);

  useEffect(() => {
    const audioElement = audioRef.current;
    if (!audioElement) return;

    const subs: Unsub[] = [];

    // default until HOC's "analyser.color" event updates it. Was previously
    // run in the render body, which fires on every render and is a side
    // effect during render - fine by luck, but not something to rely on.
    enddata.set("rgb", "255,255,255");

    const savedColor = localStorage.getItem("void-theme-color");
    if (savedColor) {
      document.documentElement.style.setProperty("--theme-color", savedColor);
    }

    // ── event wiring (re-subscribable, so it gets cleaned up) ──
    subscribe("dialog.open", () => openDialog(), subs);
    subscribe("dialog.open-folder", () => openFolder(), subs);
    subscribe("song.next", () => nextSong(), subs);
    subscribe("song.prev", () => prevSong(), subs);

    const handleEnded = () => {
      if (!audioElement.loop) nextSong();
    };
    audioElement.addEventListener("ended", handleEnded);

    const disposeBoxes = boxesManipulator(energyBackground);

    // ── one-time, non-teardownable setup ──
    // createMediaElementSource can only ever be called once for a given
    // element - calling it again throws. StrictMode deliberately mounts,
    // cleans up, and remounts effects in dev, so this half must be guarded
    // rather than torn down and rebuilt. The subscriptions above are not
    // guarded, because those DO need re-registering on remount.
    if (!bootstrapped.current) {
      bootstrapped.current = true;

      electronAPI.onOpenFiles(({ files, startIndex }) => {
        queue.current = files;
        queueIndex.current = startIndex;
        loadFile(files[startIndex]);
      });

      new AudioOutputWatcher(() => {
        audioElement.pause();
      });

      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaElementSource(audioElement);
      const analyser = new BarAnalyser(audioCtx, source);
      analyser.connect(audioCtx.destination);
      analyser.start();

      // browsers start the context suspended until a user gesture; without
      // this the very first track plays with a flat, silent analyser
      const resume = () => {
        if (audioCtx.state === "suspended") void audioCtx.resume();
      };
      audioElement.addEventListener("play", resume);
    }

    return () => {
      for (const u of subs) if (typeof u === "function") u();
      audioElement.removeEventListener("ended", handleEnded);
      disposeBoxes();
    };
  }, [loadFile, nextSong, prevSong, openDialog, openFolder]);

  // release the final blob URL when the app goes away
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, []);

  return (
    <Div className="App" id="app" position="relative" overflow="hidden">
      <EnergyBackground
        ref={energyBackground}
        themeColor="var(--theme-color)"
        noiseScale={0.15}
        speed={0.05}
        riseSpeed={0.01}
        octaves={10}
        rippleColorMix={1.1}
        opacity={0.9}
        contrast={2}
        rippleSpeed={1}
        rippleStrength={0.015}
        rippleEnergy={0.085}
        flowSteps={2}
      />
      <Bars />
      <Main className="pfixed main">
        <Button className="ctrl-btn open-btn" onClick={openDialog}>
          <FaRegFolderOpen />
        </Button>
        <Div className="title">
          <h1>█▓▒­░⡷⠂VФID⠐⢾░▒▓█</h1>
        </Div>
        <Sub />
      </Main>
      {/* src is assigned by loadFile */}
      <audio ref={audioRef} id="audio" crossOrigin="anonymous" />
    </Div>
  );
}

export default App;