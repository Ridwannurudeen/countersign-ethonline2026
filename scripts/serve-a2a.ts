import { createA2aServer, a2aLoopbackOrigin } from "../src/a2a.ts";

if (import.meta.main) {
  const [guardOrigin, publicOrigin] = process.argv.slice(2);
  if (guardOrigin === undefined || publicOrigin === undefined) {
    throw new Error("Usage: node --experimental-strip-types scripts/serve-a2a.ts <local-guard-origin> <local-a2a-origin>");
  }
  const address = a2aLoopbackOrigin(publicOrigin);
  const server = createA2aServer({ guardOrigin, publicOrigin });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(address.port || "80"), address.hostname.replace(/^\[|\]$/g, ""), resolve);
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") throw new Error("Adapter is not listening on TCP");
  address.port = String(bound.port);
  console.log(`Local A2A adapter: ${address.href}`);
  console.log("Task settlement over A2A, not open-ended negotiation.");
  process.on("SIGINT", () => server.close());
  process.on("SIGTERM", () => server.close());
}
