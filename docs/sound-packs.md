# Sound packs

Open Settings → Audio to adjust music and sound effect volume or mute them. Open Settings → SFX to choose a sound effect pack, preview individual effects, or add a custom pack. The catalog contains seven Jstris+ gameplay presets, 26 packs assembled from Eddiez-Soundz, and 29 TETR.IO+ packs from you.have.fail. Silent is selected on a fresh installation. Volume, mute, selection, and up to 12 custom packs are saved in browser storage on this device.

The catalog stores event mappings. Audio stays on the community hosts, just as skin images do. Selecting a pack loads its audio; browsing the list does not. Preview buttons leave the selection alone. Jstris+ previews load only the requested file. A TETR.IO+ preview downloads the pack's export, which holds its sounds in one recording. A failed file leaves that event silent, with a message showing how many files failed. Selecting the pack again retries failed files.

The Sprint and Zen cards each offer **Sound on finesse fault**, off by default and saved separately for each mode. It enables the selected pack's `fault` sound for that mode without changing the pack or finesse tracking. Sprint's **Reset on finesse fault** option works independently. Multiplayer and replay audio keep their existing behavior.

## Zen music

Zen plays the bundled `src/assets/zen.mp3`, prepared from the supplied `tetris_zenmode.wav`. Playback begins at 0:00, then loops from 22.857143 to 91.428571 seconds. These boundaries use the original 44.1 kHz frame positions 1,008,000 and 4,032,000. The last 15 ms blend into the audio immediately preceding the loop start to soften the join. The MP3 uses 160 kb/s stereo encoding and is about 1.8 MB. The source WAV is unchanged.

Music loads and decodes before entering or resuming audible Zen play. Resetting the Zen board leaves the current music playing continuously. The decoded buffer is reused across pauses and retries. Leaving Zen releases the buffer and cancels pending loading; Sprint, online practice, multiplayer, and replays do not load or play it. Disabled music or zero volume skips loading. Pause, settings, and focus loss pause music, and resume continues from the same position.

Music shares the sound effect player's AudioContext and uses a separate gain node. The browser handles the loop without frame callbacks or seek timers. Decoded sample memory is `duration × context sample rate × channels × 4` bytes; the compressed file size does not describe playback memory. A load failure is reported in Audio settings and allows gameplay to continue. Music preferences use the separate `42tris.music.v1` browser storage key.

## Custom packs

Paste a JSON object, a direct HTTPS link to a JSON file, or a TETR.IO+ `.tpse` sound export link, then choose **Add and use**. Both the JSON host and audio hosts must allow CORS. GitHub Pages and raw GitHub file links work; a GitHub `blob` page is an HTML page, so use its raw link instead. No upload to 42tris is required.

Choose **Use JSON as template** below any pack to put its mappings in the editor. Change the name and whichever sounds you want, then add it as a new custom pack. Saved packs keep their names and event mappings, so Jstris+ JSON manifests do not need to be fetched again. Their audio and TETR.IO+ exports still load from the saved links. Remove and re-add a linked pack to refresh its mappings.

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

Packs are limited to 64 KB of JSON and 256 unique audio links. Audio loading uses six concurrent requests, a 12-second timeout per file, an 8 MB encoded file limit, and a 64 MB decoded budget. Unsupported or failed clips are reported without interrupting gameplay.

## TETR.IO+ packs

Use a direct `.tpse` export link, not a ZIP download or the gallery page. You can also name a linked export with a small JSON reference:

```json
{
  "name": "My TETR.IO+ pack",
  "tetrioPlus": "https://you.have.fail/tetrioplus/data/tpsefiles/sfx/Octoling/pizzatower_soundexport.zip.tpse"
}
```

42tris reads only the export's audio and timing data. Skins, key bindings, and other TETR.IO+ settings are ignored. Gameplay effects map to the existing sound events, excluding piece cues and menu sounds.

The browser downloads one recording, extracts the gameplay clips, and caches them for previews and play. No audio is bundled, rehosted, or stored in browser preferences. Templates use external links with a `#tpse=` suffix naming each effect. You can replace individual effects with ordinary audio links.

Exports have a separate 24 MiB download limit with a 45-second timeout, a 16 MiB encoded-audio limit, and a temporary 256 MiB decoding limit. Only one export decodes at a time. The retained gameplay clips must fit the usual 64 MiB budget, with at most 30 seconds per clip. The first load or preview can take longer than a pack of separate audio files.

## Catalog sources

- [Jstris+ userscript](https://github.com/JstrisPlus/jstris-plus-userscript), particularly `src/customSoundPresets.js` and `src/sfxLoader.js`, defines the format and points to the preset collection.
- [Jstris+ sound presets](https://github.com/JstrisPlus/jstris-plus-assets/blob/main/presets/soundPresets.json) supplies Tetra Online, TETR.IO, Tetris Online Japan, Tetris Friends, Tetris 99, Puyo Puyo Tetris, and Tetris Battle. The local mappings omit four missing optional files (Tetris Friends single and all-clear, Puyo Puyo Tetris all-clear, and Tetris Battle all-clear) and use the available Tetris 99 T-spin single clip for its mini single.
- [Eddiez-Soundz](https://github.com/Ecdldaiiere/Eddiez-Soundz) supplies the additional packs. Only existing file names are mapped; some themes contain clear effects without movement or drop effects. Music files and combined combo recordings without timing metadata are excluded.
- [YHF@TETR.IO+](https://you.have.fail/tetrioplus/) supplies the TETR.IO+ exports. The catalog includes public current packs whose export links work with CORS and whose timings fit the loader limits. Older variants, author-only submissions, broken export links, and add-ons without matching gameplay effects are excluded. Each pack links to its gallery entry and credits its creator.

The community retains its asset hosting and credits. The Sources links in Settings lead back to the collections. Jstris+'s separate voice add-on presets (`READY` / `PB`) are outside the gameplay pack format and are not included.
