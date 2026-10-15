import type { SentinelClient } from "./sentinel-client";
import { MockSentinelClient } from "./mock-client";
import { HttpSentinelClient } from "./http-client";
import { IS_LIVE } from "./mode";

export * from "./sentinel-client";
export { MockSentinelClient } from "./mock-client";
export { HttpSentinelClient } from "./http-client";
export { DATA_SOURCE, IS_LIVE, API_BASE_URL, DATA_LABEL } from "./mode";

/**
 * Data source selector. Defaults to the simulation-backed mock client; set
 * NEXT_PUBLIC_DATA_SOURCE=http (plus NEXT_PUBLIC_API_BASE_URL) to talk to the
 * FastAPI backend (`npm run dev:live`).
 */
export const api: SentinelClient = IS_LIVE ? new HttpSentinelClient() : new MockSentinelClient();
