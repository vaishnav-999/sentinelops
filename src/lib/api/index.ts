import type { SentinelClient } from "./sentinel-client";
import { MockSentinelClient } from "./mock-client";
import { HttpSentinelClient } from "./http-client";

export * from "./sentinel-client";
export { MockSentinelClient } from "./mock-client";
export { HttpSentinelClient } from "./http-client";

/**
 * Data source selector. Defaults to the simulation-backed mock client; set
 * NEXT_PUBLIC_DATA_SOURCE=http (plus NEXT_PUBLIC_API_BASE_URL) to talk to the
 * real FastAPI backend once it exists.
 */
export const DATA_SOURCE = process.env.NEXT_PUBLIC_DATA_SOURCE ?? "mock";

export const api: SentinelClient =
  DATA_SOURCE === "http" ? new HttpSentinelClient() : new MockSentinelClient();
