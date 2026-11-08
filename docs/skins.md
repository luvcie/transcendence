# Skins

Settings → Skins includes Classic, 65 Jstris image skins, and 482 TETR.IO+ skins, with connected styles and 22 animated skins. Search by name, creator, or link. Community images stay on their original hosts. 42tris ships catalog links and credits, with no bundled community artwork.

The TETR.IO+ category contains Standard, Connected, and Animated subcategories, each with a skin count. Animated skins appear only under Animated, including those with connected artwork. The selected skin's categories open automatically. Search opens matching categories and restores their previous open or closed state when cleared. Categories are recorded in the catalog from the gallery's format labels and exported skins, so browsing does not need to download artwork to sort it.

For a custom skin, paste an HTTPS nine-column image link or a TETR.IO+ `.tpse` export link into **Custom skin link**. Select **Add and use**. Static, connected, and animated exports work. Custom links and the selected skin are saved on this device. The image or export host must allow CORS. Use the gallery's TPSE download link rather than a gallery page, ZIP, or raw TETR.IO image.

The loader reads skin images and animation timing from TETR.IO+ exports. It packs the seven colors and 24 connection variants into a small PNG, storing identical tiles once. A lookup table preserves each frame and connection shape. Tiles are capped at 32px for the 30px game cells. Connection edges are recorded within each placed piece, including diagonals for inner corners. Separate pieces never join just because their colors match. Line clears cut connections before collapsing the remaining rows. Garbage insertion, undo, hold, and next previews preserve the piece boundaries. Ghosts, garbage, and the older FOUR.lol two-row skin keep their existing appearance.

Connection edges are cosmetic data associated with board arrays outside serialized game state. In-memory game and Match snapshots copy them explicitly. Multiplayer checkpoints carry bounded base64 `boardEdges` alongside the authoritative state, so owner prediction and opponents keep the same piece boundaries after reconnects. Replay engines reconstruct edges through the shared board operations, including seeking and restart; replay formats, simulation hashes, and journal records are unchanged. A bare board snapshot without connection metadata uses standalone tiles rather than guessing connections from colors.

Exports are limited to 16 MiB and ten-second downloads. PNG dimensions are checked before decoding: a square static atlas up to 2048px, divisible by 64, or an animation with 1–64 frames of 1024px, packed at most 16 per row. Gameplay sheets are cached up to 96 entries and 64 MiB, including tile lookups. Failed exports can be retried. Browser preferences store links, not artwork or export settings.

Database skins use frame durations from the original GIF or the pack's animated gallery preview. A preview can repeat a shorter mino cycle alongside a longer ghost cycle, provided its frame count is a multiple of the exported count and the timing repeats with it. Missing or mismatched sources fall back to the export's delay in 60 Hz ticks. Custom exports outside the database use their own timing. Animation follows real time without changing game or replay state.

Built-in TETR.IO+ skin IDs are stable, short, and alphanumeric to fit the existing multiplayer protocol. Other players and competitive replay viewers resolve the same catalog ID through the usual skin loader. Custom links remain device-only.

The gallery's original GIFs block cross-origin reads (CORS). `/api/skin-source` relays them so the browser can read their timing and pixels. Only GIF paths within the gallery's content directory are accepted, with no redirects. Downloads are limited to ten seconds, 16 MiB, and four concurrent requests. Browsers can cache responses for a day. No community artwork is bundled or stored on the server.

The browser loads at most two previews at once and skips queued rows that leave view. One temporary worker at a time handles downloads, decoding, and packing for gameplay and previews, limiting peak memory. With a working `ImageDecoder`, original GIF strips are decoded frame by frame, avoiding the large PNG export. Connected layouts use the export's PNG. Source images are released after packing, and the worker terminates. Browsers without a GIF decoder use the PNG export. Those without worker canvas support pack on the main thread, yielding between animation frames.

Prepared previews have a separate cache of up to 96 entries and 32 MiB, including compressed PNGs and tile lookups. Returning to a cached skin skips downloading and packing. Previews and gameplay share the tile layout. Boards select one animation frame per render, with no conversion work during play.

Previews redraw only when the animation frame changes. The last rendered images of up to 96 recently viewed rows stay available while browsing, using about 28 MiB of canvas pixels. Static rows reappear without another load, and animated rows show their last frame while resuming from the compressed cache. Offscreen rows release their decoded animation sheets. Closing the tab or evicting an older row releases its canvas buffers; compressed previews remain cached for the session.

Sources:

- [Jstris customization database](https://konsola5.github.io/jstris-customization-database/).
- [YHF@TETR.IO+ gallery](https://you.have.fail/tetrioplus/). The catalog includes public skins and variants with accessible PNG exports, including entries labeled “unknown” whose exports contain valid block skins, such as Axiom Verge. Author-only content, ghost-only skins, unavailable exports, and animations exceeding the file or frame limits are excluded. Each entry credits its creator and links to its gallery page. Some older metadata links omit `.tpse`; the catalog uses the verified file paths from the host.
- [The gallery's atlas mapping](https://you.have.fail/tetrioplus/js/lib/skin-splicer.js) defines the Z, L, O, S, I, J, T tile positions and connection variants. The converter removes texture padding.
- [TETR.IO+'s animation loader](https://gitlab.com/UniQMG/tetrio-plus/-/blob/master/source/filters/skin/skin-tetriojs-filter.js) defines the animation frame layout and timing.
