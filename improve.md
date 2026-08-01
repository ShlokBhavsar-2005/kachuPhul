# Implementation Spec: Speed up live interaction (invite/join/kick/leave) in Kachu Phul

Context: Node/Express + Socket.io server, MongoDB (Atlas) for auth/friends, hosted on Render free tier.
Goal: make invite/join/kick/leave/reconnect feel as fast as possible given free-tier constraints, without changing game rules or scoring logic.
Files involved: `server.js` (backend), `app.js` (frontend). Do NOT change bidding/trick-resolution/scoring logic.

Work through the tasks in order. Each task lists: what to change, where, and how to verify it.

---

## Task 1 — Add timing instrumentation (do this first, remove/gate later)

- Wrap the body of these socket handlers with `console.time`/`console.timeEnd` (or `process.hrtime`) using a unique label per call: `inviteFriend`, `joinRoom`, `rejoinRoom`, `kickPlayer`, `voteKickPlayer`, `leaveRoom`.
- Around every `await db.collection(...).findOne/find/updateOne` call in the socket handlers and in `/friends/*` and `/auth/*` routes, log elapsed time for that specific query.
- Run the app for a short real session (invite a friend, join, kick, leave) and capture the logs. Report back a summary of which operations take the longest before proceeding to Task 4 (DB region), so we can confirm whether Mongo latency or cold start is dominant.
- Gate all this instrumentation behind `if (process.env.DEBUG_TIMING === 'true')` so it can be switched off without removing the code.

## Task 2 — In-memory game-name index (remove DB lookups from hot paths)

- Add a module-level `Map`: `gameNameIndex` mapping lowercase `gameName -> googleId`.
- Populate it once at startup by reading all users from Mongo (`db.collection('users').find({}, { projection: { gameName: 1, googleId: 1 } })`) after `connectDB()` succeeds.
- Update the index whenever a user registers (`/auth/register`) or renames (`/auth/rename`): add/remove/rename the key.
- In `inviteFriend` and `friends/request`, replace the `db.collection('users').findOne({ gameName: { $regex: ... } })` lookup with: look up `googleId` in `gameNameIndex` first; only fall back to the Mongo regex query if not found in the index (cache miss / edge case). If found via fallback, add it to the index.
- Verify: inviting a friend who is already known should now produce zero Mongo queries in the timing logs from Task 1 for the lookup step.

## Task 3 — Fix regex queries to use indexes

- Add a `gameNameLower` field to the `users` collection (lowercase copy of `gameName`), written at registration and rename time (backfill existing users with a one-time migration script/snippet run manually, not on every boot).
- Add a unique index on `gameNameLower`.
- Replace every `$regex: '^name$', $options: 'i'` query (in `inviteFriend`, `/friends/request`) with an exact match against `gameNameLower` using the lowercased input string.
- Verify: these queries should now show up in Mongo's explain plan as index scans, not collection scans (can check via Atlas UI or `.explain()`).

## Task 4 — Parallelize the N+1 friend status broadcast

- In `broadcastFriendStatus`, replace the `for (const friendName of user.friends) { await db.collection('users').findOne(...) }` sequential loop with a single query: `db.collection('users').find({ gameName: { $in: user.friends } }).toArray()`, then iterate the resolved array synchronously to emit updates.
- Verify: timing logs show one query instead of N sequential queries for users with multiple friends.

## Task 5 — Align hosting regions

- Confirm (report back, don't guess) which Mongo Atlas region the cluster is in and which region the Render service is deployed in.
- If they differ, migrate one so both are in the same cloud region (prefer the region closest to the majority of players — ask the user which region that should be if unclear). Note: this is a config/infra change in Render/Atlas dashboards, not a code change — flag it as a manual step for the user to perform, don't try to do it via code.

## Task 6 — Reduce/replace HTTP polling with the sockets that already exist

- The client already receives `friendStatusUpdate` pushes over the socket. Remove or increase the interval of `startFriendsPoll` (currently every 30s) — keep only a single one-shot `loadFriends()` call on reconnect/socket `authenticated` event as a resync fallback, not a recurring timer.
- Same for `startLobbyPoll` (`refreshLobbyInvitePanel`, currently every 10s) — trigger it only on relevant socket events (e.g., when a `gameInvite` arrives, or once on entering the lobby), not on a fixed interval.
- Verify: network tab should show far fewer `/friends/list` calls during normal use, while friend status still updates live via socket events.

## Task 7 — Socket.io connection/transport tuning

Server side (`server.js`, the `new Server(server, {...})` config):
- Add `perMessageDeflate: false` (skip compression overhead for these small JSON payloads).
- Add `connectionStateRecovery: {}` (enables Socket.io v4 built-in recovery so brief disconnects resync via diff rather than requiring a full manual `rejoinRoom` state rebuild). Keep the existing manual `rejoinRoom` handler as a fallback for cases recovery can't handle (e.g., server restart), don't remove it.

Client side (`app.js`, the `io({...})` call):
- Add `transports: ['websocket']` so it skips the long-polling-then-upgrade handshake and connects via WebSocket directly.
- Keep existing `reconnection`, `reconnectionAttempts`, `reconnectionDelay` settings as-is.

Verify: check browser dev tools Network/WS tab — connection should establish as WebSocket immediately (no `polling` transport requests before upgrade), and a quick disconnect/reconnect (e.g., toggle wifi briefly) should recover state noticeably faster than before.

## Task 8 — Consolidate identical per-socket emits into room broadcasts

- In `broadcastRoomUpdate`: currently loops per player calling `io.to(p.socketId).emit('roomUpdate', sanitizeRoom(room, p.socketId))`. Since `sanitizeRoom`'s `isHost` field is the only thing that varies per recipient, either: (a) leave as-is since payload differs per player, or (b) if acceptable, compute `isHost` client-side by comparing to a `hostSocketId`/host name field included in a single shared broadcast. Prefer option (a) unless told otherwise — flag this one as optional/low-priority since payload genuinely differs per player.
- In the post-kick/post-remove `yourIndex` emit loop (`room.players.forEach(p => { if (p.connected) io.to(p.socketId).emit('yourIndex', i) })`): this one is fine to leave individual since each player gets a different index — do not change.
- Look specifically for any broadcast where the exact same payload is sent to every recipient in a loop (e.g., `playerLeft`, `playerRemoved`, `spectatorJoined`, `kickVoteUpdate`, chat messages already correctly use `io.to(room.id).emit(...)` — confirm no regressions there) and make sure those already use a single `io.to(room.id).emit(...)` rather than a per-socket loop. Fix any found doing unnecessary per-socket loops for identical payloads.

## Task 9 — Optimistic UI for host actions (client-side, app.js)

- For `kickPlayer`: when the host clicks kick, immediately remove that player from the local rendered lobby list before the server confirms, then reconcile (snap to server truth) when `roomUpdate` arrives. If the server rejects (e.g., error emitted), revert the optimistic change and show the error.
- For `leaveRoom`: immediately transition the local UI out of the room view on click, don't wait for server ack, since leaving is a client-initiated action that should never be blocked.
- For `inviteFriend`: immediately show an "invite sent" state on the button/UI on click (not waiting for `inviteSent` event), then reconcile if an `error` event comes back instead (e.g., "player offline").
- Add simple click-guards (disable button / ignore repeat clicks for ~1s) on kick/invite/leave buttons to prevent duplicate requests from rapid clicking.

## Task 10 — Cold start UX (client-side)

- Add a distinct "connecting to server…" or "waking up server…" loading state shown when the initial socket connection or first API call (`/auth/status`) takes longer than ~2 seconds, so a Render cold start reads as an intentional loading screen rather than a frozen/broken UI. Use the existing socket `connect_error`/reconnect events plus a timeout to trigger this state, don't add new server endpoints for it.

## Task 11 — Production logging cleanup

- Wrap the existing `console.log` calls in `server.js` (join/kick/rejoin/game start/round messages) in a check: only log if `process.env.NODE_ENV !== 'production'`, or introduce a tiny `debugLog()` helper that no-ops in production. Don't remove the logs, just gate them.

---

## Acceptance checklist (report status of each when done)

- [ ] Timing logs captured and bottleneck confirmed (Task 1)
- [ ] Invite/friend lookups hit in-memory index, not Mongo, on cache hits (Task 2)
- [ ] Regex queries replaced with indexed exact-match lookups (Task 3)
- [ ] Friend status broadcast uses one batched query, not N sequential ones (Task 4)
- [ ] Mongo Atlas and Render regions confirmed/aligned (Task 5 — manual infra step)
- [ ] Friends/lobby HTTP polling reduced to event-driven resync only (Task 6)
- [ ] Socket.io server config: `perMessageDeflate: false`, `connectionStateRecovery` enabled (Task 7)
- [ ] Socket.io client config: `transports: ['websocket']` (Task 7)
- [ ] No unnecessary per-socket emit loops for identical payloads (Task 8)
- [ ] Optimistic UI added for kick/leave/invite (Task 9)
- [ ] Cold-start loading state added client-side (Task 10)
- [ ] Console logs gated behind non-production check (Task 11)

Do not modify: card dealing, bidding, trick-resolution, scoring, or the round/game-over transition timings (`setTimeout` delays used for animations) — those are intentional and unrelated to this optimization pass.