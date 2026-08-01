# Implementation Spec: Icon cleanup + turn-indicator bug fix

Context: static `index.html` + `style.css` + `app.js`, no build step, no framework. All fixes must stay dependency-free (no icon font/CDN required — use inline SVG so it works offline and matches existing color variables).
Covers: selected items 1–11 from the UI review. Do not touch game logic, sockets, or the recent latency-optimization work — this pass is purely visual/UI plus the one specific bug in Task 11.

Guiding principle for every task below: **default to removing the emoji entirely** and letting typography/color/button styling carry the label. Only add a replacement icon where it genuinely improves quick scannability (e.g., a row of nav tabs, or a section someone needs to spot at a glance) — don't reflexively swap one emoji for one icon everywhere. This is what makes it read as a designed app rather than an assembled one.

---

## Task 1 — Build one small inline SVG icon set (foundation for all other tasks)

- Add a single inline SVG `<symbol>` sprite sheet near the top of `index.html` (inside a hidden `<svg style="display:none">` block), or a small `ICONS` object of SVG template strings in `app.js` — pick whichever fits the existing code style better, but there should be exactly **one** source of icons, not ad-hoc SVGs scattered around.
- Every icon in the set must share: the same viewBox convention (e.g., 24x24), the same stroke width (1.5–2px), line-style/outline construction (not filled/solid shapes, not colorful), and `stroke="currentColor"` / `fill="currentColor"` so each icon inherits whatever text color is already used in that context (`var(--gold)`, `var(--text2)`, `var(--red)`, etc.) instead of carrying its own fixed color like emoji do.
- Only include icons actually needed by the tasks below: people/friends, person-add (invite), exit/leave, refresh/repeat, bar-chart (scores), chat bubble, edit/pencil, eye (spectating). Keep the set minimal — don't pre-build icons for concepts nothing currently needs.
- Icons should render inline at a small fixed size (roughly matching the current emoji's visual weight, ~16–20px) and align on the same baseline as the adjacent text via flex/inline-flex, not float oddly above/below the text like emoji sometimes do.

## Task 2 — Remove the flower decoration (item 1)

- Remove `🌸` from all four locations: the `<title>` tag, both auth-screen `<h1>Kachu Phul</h1>` headers, and the top-nav brand (`♠ Kachu Phul`).
- Keep the `♠` suit symbol in the top-nav brand as-is — it's already a genuine, thematically relevant mark for a card game and doesn't need replacing.
- Do not add a substitute icon here. Let the existing gold color + cursive display font carry the branding.

## Task 3 — Consolidate the three different uses of 👥 (item 2)

- Top-nav icon (with the notification dot): replace with the "people" icon from the set. This one keeps an icon since it's a nav-tab-style element that benefits from at-a-glance recognition.
- "Squad" section header: replace with the same "people" icon, for consistency with the nav icon representing the same concept.
- "Invite Friends" button: replace with the "person-add" icon (not the plain people icon), since this is a distinct action (adding someone) rather than viewing a list — the icon should visually differ from the two above to avoid the "same icon, different meaning" problem.
- Empty-friends state icon (currently a large 👥 in the empty-state div): replace with the same "people" icon at a larger size, muted/secondary color (`var(--text2)` or similar), rather than emoji.

## Task 4 — Section header icons (item 3)

Apply consistent treatment across "Play," "Squad," "Place Bid," "Scores," and "Chat" headers — currently each uses an unrelated emoji family:

- "🎴 Play" — remove the icon entirely; "Play" as a plain text header is clear on its own and doesn't need a card-glyph decoration.
- "👥 Squad" — handled in Task 3 (people icon).
- "📝 Place Bid" — replace with a more fitting icon than a memo (bidding isn't note-taking); use a simple numeric/target-style icon from the set, or remove entirely and rely on the header text + gold accent styling. Default to removing unless it clearly helps scannability in the bid modal.
- "📊 Scores" / "📊 Full Scoreboard" — replace both instances with the "bar-chart" icon from the set (same icon both places, since it's the same concept in two contexts).
- "💬 Chat" — replace with the "chat bubble" icon from the set for both the chat FAB button and the chat panel header.

## Task 5 — Leave Room / Leave / Leave? (item 4)

- Replace all three instances of 🚪 (the lobby "Leave Room" button, the in-game "Leave" button, and the "Leave?" confirmation header) with one consistent "exit" icon from the set, used identically in all three places.
- Keep the existing red color styling on these buttons — that's already doing the job of signaling a destructive/exit action; the icon just needs to stop being an emoji.

## Task 6 — Start Game button (item 5)

- Remove 🚀 entirely. The button is already the primary gold CTA with clear text ("Start Game") — no icon needed. This removes the most cliché "AI-generated CTA" pattern directly.

## Task 7 — Game Over header (item 6)

- Remove 🏆 from "Game Over!". Let the heading's existing large gold typography communicate the moment — no icon replacement needed here.

## Task 8 — Menu button (item 7)

- Remove 🏠 from the "Menu" button on the game-over screen. Plain text button, consistent with the outline-button style already used elsewhere in the app.

## Task 9 — Unify the two refresh glyphs (item 8)

- Replace both the friends-list "↻ Refresh" button and the "🔄 Play Again" button with the same single "refresh/repeat" icon from the set, so the same concept (repeat/refresh) always looks identical wherever it appears.
- Keep the distinct text labels ("Refresh" vs "Play Again") — only the glyph needs to be unified, not the wording.

## Task 10 — General consistency + density audit (items 9 & 10)

After Tasks 2–9 are done, do one pass over the rest of `index.html` for anything left over that follows the same problematic pattern, even if not explicitly listed above — specifically the remaining emoji: "✏️ Rename Yourself" header, "📋 Copy Code" button, and "👁 Spectating" badge. Apply the same rule as everywhere else:
- "✏️ Rename Yourself" → either remove entirely (plain text header is enough for a modal titled by its own form), or replace with a small "pencil" icon from the set if you want to keep visual weight — pick removal by default.
- "📋 Copy Code" → remove the icon; the button text already says what it does. If you want a subtle affordance, a small "copy" icon from the set is acceptable here since it's a common, instantly-recognizable UI convention (unlike decorative emoji).
- "👁 Spectating" badge → replace with the "eye" icon from the set, small and muted, since this is a persistent status badge where a quick glyph does help scannability.
- Confirm no other emoji remain anywhere in `index.html` after this pass (do a final search for any emoji character across the file).
- Double check: every icon that *does* remain uses the Task 1 icon set (same stroke weight/size/style) — nothing should still be a raw emoji character or a one-off SVG that doesn't match the set.

## Task 11 — Fix the turn-indicator / playable-card mismatch bug

Bug: when the last player plays the closing card of a trick, the server-side turn calculation (leader index + trick length, modulo player count) wraps back to point at that trick's original leader while the trick is still resolving/animating — before the actual winner has been determined and assigned as the next leader. `renderTurnIndicator()` in `app.js` already has a guard for this (`trickComplete` check that shows "Resolving hand…" instead of a player name), but `renderHand()` does not have the same guard, so during that ~1–3 second resolution window the trick's original leader sees their own hand light up with the "playable" highlight as if it's their turn — even though no one can actually play until the trick resolves.

Fix: in `renderHand()`, add the same `trickComplete` check already used in `renderTurnIndicator()` (i.e., `state.currentTrick.length >= state.players.length`) to the `isMyTurn` calculation, so cards are never shown as playable/highlighted while a trick is mid-resolution, regardless of what `currentTurnIndex` currently reports. `canPlayCard()` should get the same guard for consistency, even though the server already rejects plays during this window — the client-side check should match what the server actually allows.

Verify: play a full trick as the trick's leader (first to throw) and watch your own hand during the ~1–3 second window after the last player throws — your cards should show as disabled/dimmed during "Resolving hand…", not glowing/playable, regardless of whether you end up winning the next lead.

---

## Acceptance checklist

- [ ] Single inline SVG icon set added, all icons share stroke/size/style (Task 1)
- [ ] Flower emoji removed from title/headers/nav brand, no replacement added (Task 2)
- [ ] 👥 usages consolidated to two distinct icons (people vs person-add) (Task 3)
- [ ] Section header icons resolved per-header (some removed, some replaced) (Task 4)
- [ ] All three "leave" instances use one consistent exit icon (Task 5)
- [ ] Rocket removed from Start Game (Task 6)
- [ ] Trophy removed from Game Over (Task 7)
- [ ] House removed from Menu (Task 8)
- [ ] Refresh and Play Again use the same icon (Task 9)
- [ ] Rename/Copy Code/Spectating cleaned up, no emoji remain anywhere in index.html (Task 10)
- [ ] Playable-card highlight no longer shows during trick resolution (Task 11)