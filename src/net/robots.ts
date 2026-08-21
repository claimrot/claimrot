import { ROBOTS_UA } from "./politeness.js";

const ROBOTS_FETCH_TIMEOUT_MS = 10_000;

/** Fetch robots.txt for a host. Failures are treated as an absent file, never a silent refusal. */
export async function fetchRobots(
  host: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  try {
    const response = await fetchImpl(`https://${host}/robots.txt`, {
      headers: { "user-agent": ROBOTS_UA },
      signal: AbortSignal.timeout(ROBOTS_FETCH_TIMEOUT_MS),
    });
    return response.ok ? await response.text() : "";
  } catch {
    return "";
  }
}
