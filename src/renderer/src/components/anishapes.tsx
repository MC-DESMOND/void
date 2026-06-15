// FallingShapes.tsx
import { Div } from "./addons/ctsx";
// import "@renderer/styles/falling-shapes.css";

const SHAPES = [
  "square", "thin-rect", "square", "circle",
  "diamond", "square", "thin-rect", "circle",
  "square", "thin-rect", "diamond", "circle",
  "square filled", "thin-rect", "circle", "square",
] as const;

export default function FallingShapes() {
  return (
    <Div className="shapes-container">
      {SHAPES.map((type, i) => (
        <Div key={i} className={`shape ${type}`} />
      ))}
    </Div>
  );
}