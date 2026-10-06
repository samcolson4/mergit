// A live connection to one branch of a board: a Yjs document kept in sync
// over a WebSocket, plus JSON control messages (presence, ref updates).
//
// Wire format: binary frames are Yjs updates; text frames are JSON.

import * as Y from "yjs";

export class Session {
  constructor(url, { onSynced, onMessage, onStatus }) {
    this.url = url;
    this.handlers = { onSynced, onMessage, onStatus };
    this.doc = new Y.Doc();
    this.synced = false;
    this.closed = false;
    this.retries = 0;
    this.doc.on("update", (update, origin) => {
      if (origin !== this && this.ws?.readyState === WebSocket.OPEN) this.ws.send(update);
    });
    this.open();
  }

  open() {
    const ws = (this.ws = new WebSocket(this.url));
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.retries = 0;
      // After a reconnect, hand the server anything we edited while offline.
      // CRDT merges are idempotent, so resending known state is harmless.
      if (this.synced) ws.send(Y.encodeStateAsUpdate(this.doc));
      this.handlers.onStatus?.("live");
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") {
        Y.applyUpdate(this.doc, new Uint8Array(e.data), this);
        return;
      }
      const msg = JSON.parse(e.data);
      if (msg.type === "synced") {
        if (!this.synced) {
          this.synced = true;
          this.handlers.onSynced?.();
        }
      } else {
        this.handlers.onMessage?.(msg);
      }
    };
    ws.onclose = () => {
      if (this.closed) return;
      this.handlers.onStatus?.("offline");
      setTimeout(() => !this.closed && this.open(), Math.min(10_000, 500 * 2 ** this.retries++));
    };
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  get live() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  close() {
    this.closed = true;
    this.ws?.close();
    this.doc.destroy();
  }
}
