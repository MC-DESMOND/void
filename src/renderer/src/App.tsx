import { BarAnalyser } from "./components/BarAnaliser";
import { useEffect, useRef } from "react";
// import { AudioController } from "./components/AudioControler";
import { Button, Div, Main } from "./components/addons/ctsx";
import { endlnr,enddata } from "./components/addons/HOC";
// import { toVoidUrl } from "./components/CONST";
import boxesManipulator from "./components/boxm";
import Bars from "./components/Bars";
import FallingShapes from "./components/anishapes";
import Sub from "./components/sub";
import { FaRegFolderOpen } from "react-icons/fa6";


async function loadFile(filePath: string) {
  const audioElement = document.getElementById("audio") as HTMLAudioElement;
  const buffer = await (window as any).electronAPI.readFile(filePath);
  const blob = new Blob([buffer], { type: "audio/mpeg" });
  const blobUrl = URL.createObjectURL(blob);

  const fileName = filePath.split("\\").pop()?.replace(/\.[^.]+$/, "") ?? "Unknown";
  endlnr.emit("song.loaded", { name: fileName });

  audioElement.src = blobUrl;
  audioElement.load();
  audioElement.play();
}

async function openDialog() {
  const paths: string[] = await (window as any).electronAPI.openDialog();
  if (paths.length > 0) loadFile(paths[0]);
}

function App(): React.JSX.Element {
  const initialized = useRef(false);
  

  const queue = useRef<string[]>([]);
  const queueIndex = useRef(0);

  enddata.set("rgb", "255,255,255"); // default to white — will be updated by HOC's "analyser.color" event
  const boxs = Array.from({ length: 20 }, (_, i) => <Div key={i} className="lines">
    {Array.from({ length: 10 }, (_, i) => <Div key={i} className="box">
  </Div>)}
  </Div>);

  useEffect(() => {
    if (initialized.current) return; // block double-init in StrictMode
    initialized.current = true;
    // restore saved theme color
  const savedColor = localStorage.getItem("void-theme-color");
  if (savedColor) {
    document.documentElement.style.setProperty("--theme-color", savedColor);
  }

    // initCirclePulse();
    // boxesManipulator();
    endlnr.on("dialog.open", async ({}) => {
      const paths: string[] = await (window as any).electronAPI.openDialog();
      if (paths.length > 0) loadFile(paths[0]);
    });
    (window as any).electronAPI.onOpenFiles(
  ({ files, startIndex }: { files: string[], startIndex: number }) => {
    queue.current = files;
    queueIndex.current = startIndex;
    loadFile(files[startIndex]);
  }
);



    // const audioCtx = new AudioContext();
    const audioElement = document.getElementById("audio") as HTMLAudioElement;
    // const controller = new AudioController(audioElement);

    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaElementSource(audioElement);
    const analyser = new BarAnalyser(audioCtx, source);
    analyser.connect(audioCtx.destination);
    analyser.start();

    boxesManipulator();

    // controller.load(toVoidUrl());

    async function openFolder() {
  const paths: string[] = await (window as any).electronAPI.openFolder();
  if (paths.length === 0) return;
  queue.current = paths;
  queueIndex.current = 0;
  loadFile(paths[0]);
}

function nextSong() {
  if (queue.current.length === 0) return;
  queueIndex.current = (queueIndex.current + 1) % queue.current.length;
  loadFile(queue.current[queueIndex.current]);
}

function prevSong() {
  if (queue.current.length === 0) return;
  queueIndex.current = (queueIndex.current - 1 + queue.current.length) % queue.current.length;
  loadFile(queue.current[queueIndex.current]);
}

// wire up via endlnr so buttons can call them from anywhere
endlnr.on("song.next", ({}) => nextSong());
endlnr.on("song.prev", ({}) => prevSong());
endlnr.on("dialog.open-folder", ({}) => openFolder());

// auto advance when song ends
// const audioElement = document.getElementById("audio") as HTMLAudioElement;
audioElement?.addEventListener("ended", () => {
  
  if (!audioElement?.loop) nextSong();
});
    
  }, []);

  return (
    <Div className="App" id="app" position="relative" overflow="hidden">
      <Div className="boxes">
         <Div className="boxes-glow"></Div>
        {boxs}
      </Div>
      <FallingShapes />
      {/* <BgPic></BgPic> */}
      <Bars></Bars>
      <Main className="pfixed main">
        <Button className="ctrl-btn open-btn" onClick={openDialog}>
          <FaRegFolderOpen />
        </Button>
        <Div className="title">
          <h1>█▓▒­░⡷⠂VФID⠐⢾░▒▓█</h1>
        </Div>
        <Sub></Sub>
      </Main>
      <audio id="audio" crossOrigin="anonymous"  ></audio>  {/* no src here — controller handles it */}
    </Div>
  );
}

export default App;