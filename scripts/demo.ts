import { runLiveFlow } from "./live-flow.ts";

runLiveFlow("approved").catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Countersign demo failed: ${message}`);
  process.exitCode = 1;
});
