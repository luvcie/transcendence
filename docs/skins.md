# Skins

Settings → Skins includes Classic, 65 Jstris image skins, and 286 static TETR.IO+ skins. Search by name, creator, or link. Community images stay on their original hosts. 42tris ships catalog links and credits, with no bundled community artwork.

For a custom skin, paste an HTTPS nine-column image link or a static TETR.IO+ `.tpse` export link into **Custom skin link**. Select **Add and use**. Custom links and the selected skin are saved on this device. The image or export host must allow CORS. Use the gallery's TPSE download link rather than a gallery page, ZIP, or raw TETR.IO image.

TETR.IO+ exports hold normalized PNG atlases. The loader reads only the `skin` image, crops the seven piece tiles into our nine-column layout, and caches the small converted canvas. Ghosts and garbage keep their existing appearance. Animated exports are rejected. Connected skins are outside the catalog and do not gain connected rendering when imported.

Exports are limited to 8 MiB and ten-second downloads. PNG dimensions are checked before image decoding: a square atlas up to 2048px, divisible by 64. Converted sheets use the existing 96-image cache, shared by previews and selection. Invalid or failed exports are evicted so the same link can be retried. Full atlases and export settings are not saved in browser preferences.

Built-in TETR.IO+ skin IDs are stable, short, and alphanumeric to fit the existing multiplayer protocol. Other players and competitive replay viewers resolve the same catalog ID through the usual skin loader. Custom links remain device-only. Game state, replay journals, and rendering rules are unchanged.

Sources:

- [Jstris customization database](https://konsola5.github.io/jstris-customization-database/).
- [YHF@TETR.IO+ gallery](https://you.have.fail/tetrioplus/). The catalog includes public static, unconnected skins with accessible PNG exports. Older alternate variants, author-only content, unavailable exports, animations, and connected skins are excluded. Each entry credits its creator and links to its gallery page. Some older metadata links omit `.tpse`; the catalog uses the verified file paths from the host.
- [The gallery's atlas mapping](https://you.have.fail/tetrioplus/js/lib/skin-splicer.js) defines the Z, L, O, S, I, J, T tile positions. The converter selects the unconnected tile and removes its texture padding.
