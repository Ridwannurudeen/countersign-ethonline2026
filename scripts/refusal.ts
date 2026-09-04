import { runLiveFlow } from "./live-flow.ts";

runLiveFlow("refused").catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Countersign refusal demo failed: ${message}`);
  process.exitCode = 1;
});
