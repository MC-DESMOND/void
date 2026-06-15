import { Div } from "./addons/ctsx";
import { useEffect } from "react";
import { endlnr } from "./addons/HOC";

export default function Bars() {
  useEffect(() => {
    endlnr.on("analyser.bars.norm", ({ bars }) => {
      const container = document.querySelector(".bars") as HTMLElement;
      if (!container) return;

      const children = container.children;
      for (let i = 0; i < children.length; i++) {
        const bar = children[i] as HTMLElement;
        const value = bars[i] ?? 0;
        const height = (value / 255) * 20;
        bar.style.height = `${height}%`;
      }
    });
  }, []);

  const barEls = Array.from({ length: 128 }, (_, i) => (
    <Div key={i} className="bar-item" />
  ));

  return (
    <Div className="bars pfixed">
      {barEls}
    </Div>
  );
}