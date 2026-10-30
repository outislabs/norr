import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import type { AddressInfo } from "node:net";

/** Listen on a port (0 picks a free one) and report the URL. Used by main and by end-to-end tests. */
export function listen(app: Hono<any>, port = 0): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port }, (info: AddressInfo) =>
      resolve({ url: `http://127.0.0.1:${info.port}`, close: () => new Promise((r) => server.close(() => r())) }),
    );
  });
}
