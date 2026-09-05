import { RecordSteerToggle } from "./RecordSteerToggle";
import type { ProjectorProcess, ProjectorSnapshot } from "./types";
import { stageOf } from "./stage";
export function ProjectRecorder({
  process,
  snapshot,
  branch,
  grow = false,
}: {
  process: ProjectorProcess;
  snapshot: ProjectorSnapshot;
  branch?: string | null;
  grow?: boolean;
}) {
  const transcript = snapshot.transcript;
  const landing = snapshot.steerLanding ?? null;
  const micActive = snapshot.mic?.active === true;
  if (process.steeringMode === "grow" || grow)
    return (
      <RecordSteerToggle
        process={process}
        kind="grow"
        transcript={transcript}
        landing={landing}
        micActive={micActive}
      />
    );
  if (process.treeRepo?.adopted || stageOf(process) === "self")
    return (
      <RecordSteerToggle
        process={process}
        kind="room"
        branch={branch ?? null}
        transcript={transcript}
        landing={landing}
        micActive={micActive}
      />
    );
  return (
    <RecordSteerToggle
      process={process}
      kind="build"
      transcript={transcript}
      micActive={micActive}
    />
  );
}
