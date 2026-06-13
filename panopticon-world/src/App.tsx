import { useState } from "react";
import { WorldCanvas } from "./scene/WorldCanvas.tsx";
import { BubbleQueue } from "./ui/BubbleQueue.tsx";
import { DialogueBox } from "./ui/DialogueBox.tsx";
import { ErrorBoundary } from "./ui/ErrorBoundary.tsx";
import { Hud } from "./ui/Hud.tsx";
import { Inspector } from "./ui/Inspector.tsx";
import { Legend } from "./ui/Legend.tsx";
import { OptionsMenu } from "./ui/OptionsMenu.tsx";

export function App() {
  const [legend, setLegend] = useState(true);
  return (
    <>
      <ErrorBoundary label="3D world">
        <WorldCanvas />
      </ErrorBoundary>
      <div className="ui-layer">
        <Hud onLegend={() => setLegend(true)} />
        <OptionsMenu />
        <BubbleQueue />
        <Inspector />
        <DialogueBox />
      </div>
      {legend && <Legend onClose={() => setLegend(false)} />}
    </>
  );
}
