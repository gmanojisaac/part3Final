import { parseWebhookLine } from "./parseWebhook";
import { upsertMachine } from "./machineRegistry";
import { socketManager } from "./dataSocket";

export async function handleWebhook(body: any) {
  const line: string = typeof body === "string" ? body : (body.text ?? "");
  if (!line) throw new Error("No webhook text payload");

  const parsed = parseWebhookLine(line);
  const { fyersSymbol, action, meta } = parsed;

  // ensure machine & subscribe to ticks
  const machine = upsertMachine(fyersSymbol, meta.underlying);
  socketManager.subscribe([fyersSymbol]);

  if (action === "ENTRY") {
    await machine.onSignal("BUY_SIGNAL");
  } else {
    await machine.onSignal("SELL_SIGNAL");
  }
}
