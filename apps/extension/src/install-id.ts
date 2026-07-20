/**
 * Persistent per-install identifier.
 *
 * Stored in chrome.storage.sync (not .local) so it follows the user's Google
 * account across machines instead of resetting per-device. Sent as the
 * X-Install-Id header on /api/solve so the server can bucket the free-tier
 * rate limit per install instead of one shared "anon" bucket — see
 * docs/planning.md §4. It's a random UUID, not PII.
 */

const STORAGE_KEY_INSTALL_ID = "installId";

export async function getInstallId(): Promise<string> {
  const r = await chrome.storage.sync.get(STORAGE_KEY_INSTALL_ID);
  const existing = r[STORAGE_KEY_INSTALL_ID] as string | undefined;
  if (existing) return existing;

  const id = crypto.randomUUID();
  await chrome.storage.sync.set({ [STORAGE_KEY_INSTALL_ID]: id });
  return id;
}
