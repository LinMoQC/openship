const TERMINAL_RECEIPTS = ["accepted", "superseded", "duplicate", "noop"];
// Every release ever recorded stays in the inbox. Reading its blobs one at a time
// made cold inspection grow with history until registration outlived the proxy
// deadline; the blobs are independent, so a few workers read them together.
const INBOX_READ_CONCURRENCY = 8;
export type InboxEvent = { key: string; receivedAt: string; payload: Record<string, unknown> };
export async function pendingInboxEvents(readBlob: (sha: string) => Promise<string>, stack: string, files: Array<{ name: string; sha: string }>, receipts: Array<{ name: string; sha: string }>, concurrency = INBOX_READ_CONCURRENCY): Promise<InboxEvent[]> {
  const receiptByName = new Map(receipts.map(file => [file.name, file.sha]));
  const events = files.filter(f => /^[a-f0-9]{64}\.json$/.test(f.name));
  const found: Array<InboxEvent | null> = new Array(events.length).fill(null);
  let next = 0, failed = false;
  const worker = async () => {
    // One failed read fails the inspection; stop handing out more reads.
    while (!failed && next < events.length) {
      const index = next++;
      try {
        const event = JSON.parse(await readBlob(events[index]!.sha)) as InboxEvent;
        if (event.payload?.stack !== stack) continue;
        const receiptSha = receiptByName.get(`${event.key}.json`);
        if (receiptSha && TERMINAL_RECEIPTS.includes(JSON.parse(await readBlob(receiptSha)).status)) continue;
        found[index] = event;
      } catch (error) { failed = true; throw error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, events.length) }, worker));
  return found.filter((event): event is InboxEvent => event !== null);
}
