# Sound packs

Open Settings → Sounds to choose a pack, preview individual effects, or add a custom pack. The catalog contains seven Jstris+ gameplay presets and 26 packs assembled from Eddiez-Soundz. Silent is selected on a fresh installation. Volume, mute, selection, and up to 12 custom packs are saved in browser storage on this device.

The catalog stores event mappings. Audio stays on the community hosts, just as skin images do. Selecting a pack loads its audio; browsing the list does not. Preview buttons load only the requested clip and leave the selection alone. A failed file leaves that event silent, with a message showing how many files failed. Selecting the pack again retries failed files.

## Custom packs

Paste a JSON object or a direct HTTPS link to a JSON file, then choose **Add and use**. Both the JSON host and audio hosts must allow CORS. GitHub Pages and raw GitHub file links work; a GitHub `blob` page is an HTML page, so use its raw link instead. No upload to 42tris is required.

Choose **Use JSON as template** below any pack to put its mappings in the editor. Change the name and whichever sounds you want, then add it as a new custom pack. Linked packs are saved as a snapshot of their JSON, so reopening the game does not depend on the JSON host. Remove and re-add a linked pack to refresh its mappings. Its audio still loads from the saved links.

This is a valid small pack; replace the example links with your audio URLs:

```json
{
  "name": "My sounds",
  "move": "https://example.com/move.ogg",
  "harddrop": "https://example.com/drop.ogg",
  "scoring": {
    "CLEAR1": "https://example.com/single.ogg",
    "CLEAR4": "https://example.com/quad.ogg",
    "TSPIN_DOUBLE": "https://example.com/tspin.ogg",
    "PERFECT_CLEAR": "https://example.com/all-clear.ogg"
  },
  "spawns": {
    "I": "https://example.com/i.ogg"
  },
  "comboTones": [null, "https://example.com/combo1.ogg"],
  "specialScoring": {
    "CLEAR4": [
      { "url": "https://example.com/b2b.ogg", "b2b": true, "override": true }
    ],
    "TSPINORTETRIS": [
      { "url": "https://example.com/power.ogg", "combo": 2, "override": false }
    ]
  }
}
```

JSON must use quoted keys and cannot contain comments. Unspecified effects stay silent. Hard drop uses `lock` if `harddrop` is absent. Supported audio formats depend on the browser; the catalog uses WAV, MP3, and Ogg.

`comboTones` accepts an array of URLs or null entries, indexed from combo 0. Higher combos reuse the final entry. It also accepts Jstris audio sprites:

```json
{
  "name": "Sprite example",
  "comboTones": {
    "url": "https://example.com/combos.mp3",
    "duration": 1000,
    "spacing": 500,
    "cnt": 20
  }
}
```

Duration and spacing are milliseconds. Tone `n` starts at `n × (duration + spacing)` and plays for `duration` milliseconds.

Every condition on a `specialScoring` rule must match: `b2b` is a boolean and `combo` is a minimum combo count. Within each event, the rule with the most conditions wins; ties use the highest matching combo threshold. `override: true` suppresses the ordinary scoring sound. Combo and all-clear sounds can still play. `TSPINORTETRIS` matches line-clearing T-spins and quads, `ALLSPIN` matches other piece spins, and `ANY` matches any placement. Repeated references to the same clip within a clear play once.

The parser accepts Jstris+'s regular event and scoring keys. Gameplay currently emits `move`, `rotate`, `hold`, `harddrop`, `lock`, `land`, `linefall`, `garbage`, `b2b`, `ready`, `go`, `died`, `fault`, and Sprint `success`, plus line clears, T-spins, all clears, combos, piece spawns, and drop scoring. Jstris events such as `msg`, `item`, `pickup`, and `golive` have no corresponding 42tris action. Sound effects apply to your board in solo and online play.

Replays use your current sound pack and volume. Sprint audio follows each recorded operation, including actions between displayed frames. Competitive replay audio follows your board and plays every lock and clear event. Pause, seeking, restart, and speed changes stop active clips. Seeking is silent, and playback resumes sounds from the new position. The audio adapter leaves the replay engine, recordings, and verification unchanged.

Packs are limited to 64 KB of JSON and 256 unique audio links. Audio loading uses six concurrent requests, a 12-second timeout per file, an 8 MB encoded file limit, and a 64 MB decoded budget. These limits keep remote packs from exhausting browser resources. Unsupported or failed clips are reported without interrupting gameplay.

## Catalog sources

- [Jstris+ userscript](https://github.com/JstrisPlus/jstris-plus-userscript), particularly `src/customSoundPresets.js` and `src/sfxLoader.js`, defines the format and points to the preset collection.
- [Jstris+ sound presets](https://github.com/JstrisPlus/jstris-plus-assets/blob/main/presets/soundPresets.json) supplies Tetra Online, TETR.IO, Tetris Online Japan, Tetris Friends, Tetris 99, Puyo Puyo Tetris, and Tetris Battle. The local mappings omit four missing optional files (Tetris Friends single and all-clear, Puyo Puyo Tetris all-clear, and Tetris Battle all-clear) and use the available Tetris 99 T-spin single clip for its mini single.
- [Eddiez-Soundz](https://github.com/Ecdldaiiere/Eddiez-Soundz) supplies the additional packs. Only existing file names are mapped; some themes contain clear effects without movement or drop effects. Music files and combined combo recordings without timing metadata are excluded.

The community retains its asset hosting and credits. The Sources links in Settings lead back to the collections. Jstris+'s separate voice add-on presets (`READY` / `PB`) are outside the gameplay pack format and are not included.
