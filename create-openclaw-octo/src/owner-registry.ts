/**
 * Owner identity registry — maps accountId to the bot owner's UID.
 *
 * The owner_uid is obtained from registerBot() and registered during startAccount().
 * Owner users have full access to all cross-session queries.
 */

const _ownerUidMap = new Map<string, string>(); // accountId → owner_uid

export function registerOwnerUid(accountId: string, ownerUid: string): void {
  _ownerUidMap.set(accountId, ownerUid);
}

export function isOwner(accountId: string, uid: string): boolean {
  return _ownerUidMap.get(accountId) === uid;
}

/** Visible for testing — clears all owner registrations. */
export function _clearOwnerRegistry(): void {
  _ownerUidMap.clear();
}
