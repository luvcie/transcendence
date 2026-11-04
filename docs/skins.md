# Skins

Settings → Skins includes Classic, 65 Jstris image skins, and 483 TETR.IO+ skins, with connected styles and 23 animated skins. Search by name, creator, or link. Community images stay on their original hosts. 42tris ships catalog links and credits, with no bundled community artwork.

The TETR.IO+ category contains Standard, Connected, and Animated subcategories, each with a skin count. Animated skins appear only under Animated, including those with connected artwork. The selected skin's categories open automatically. Search opens matching categories and restores their previous open or closed state when cleared. Categories are recorded in the catalog from the gallery's format labels and exported skins, so browsing does not need to download artwork to sort it.

For a custom skin, paste an HTTPS nine-column image link or a TETR.IO+ `.tpse` export link into **Custom skin link**. Select **Add and use**. Static, connected, and animated exports work. Custom links and the selected skin are saved on this device. The image or export host must allow CORS. Use the gallery's TPSE download link rather than a gallery page, ZIP, or raw TETR.IO image.

TETR.IO+ exports hold normalized PNG atlases. The loader reads only the skin images and animation timing, crops the seven colors and 24 connection variants into nine-column sheets, and caches the converted canvas. Tiles are capped at 32px for the 30px game cells. Connection edges are recorded within each placed piece, including diagonals for inner corners. Separate pieces never join just because their colors match. Line clears cut connections before collapsing the remaining rows. Garbage insertion, undo, hold, and next previews preserve the piece boundaries. Ghosts, garbage, and the older FOUR.lol two-row skin keep their existing appearance.

Connection edges are cosmetic data associated with board arrays outside serialized game state. In-memory game and Match snapshots copy them explicitly. Multiplayer checkpoints carry bounded base64 `boardEdges` alongside the authoritative state, so owner prediction and opponents keep the same piece boundaries after reconnects. Replay engines reconstruct edges through the shared board operations, including seeking and restart; replay formats, simulation hashes, and journal records are unchanged. A bare board snapshot without connection metadata uses standalone tiles rather than guessing connections from colors.

Exports are limited to 16 MiB and ten-second downloads. PNG dimensions are checked before image decoding: a square static atlas up to 2048px, divisible by 64, or an animation with 1–64 frames of 1024px, packed at most 16 per row. Animation delay uses TETR.IO+'s 60 Hz ticks. Frames follow real time without changing game or replay state. Settings previews animate while visible and release their sheets when hidden. Converted sheets use the shared cache, bounded by 96 entries and 64 MiB of decoded pixels. Invalid or failed exports are evicted so the same link can be retried. Full atlases and export settings are not saved in browser preferences.

Built-in TETR.IO+ skin IDs are stable, short, and alphanumeric to fit the existing multiplayer protocol. Other players and competitive replay viewers resolve the same catalog ID through the usual skin loader. Custom links remain device-only.

Sources:

- [Jstris customization database](https://konsola5.github.io/jstris-customization-database/).
- [YHF@TETR.IO+ gallery](https://you.have.fail/tetrioplus/). The catalog includes public skins and variants with accessible PNG exports, including entries labeled “unknown” whose exports contain valid block skins, such as Axiom Verge. Author-only content, ghost-only skins, unavailable exports, and animations exceeding the file or frame limits are excluded. Each entry credits its creator and links to its gallery page. Some older metadata links omit `.tpse`; the catalog uses the verified file paths from the host.
- [The gallery's atlas mapping](https://you.have.fail/tetrioplus/js/lib/skin-splicer.js) defines the Z, L, O, S, I, J, T tile positions and connection variants. The converter removes texture padding.
- [TETR.IO+'s animation loader](https://gitlab.com/UniQMG/tetrio-plus/-/blob/master/source/filters/skin/skin-tetriojs-filter.js) defines the animation frame layout and timing.
