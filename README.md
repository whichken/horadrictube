# Horadric Tube

A self-hosted Sonarr/Radarr webhook service that creates smaller HEVC companions for Plex. Originals stay untouched. A file named `Movie.mkv` becomes `Movie HEVC.mkv` in the same directory.

Version 2 is a complete rewrite: Bun 1.4.2, strict TypeScript, built-in SQLite, and direct ffmpeg processes. No Redis, external database, or AI subscription is required. The default profile targets **1080p maximum**, never upscales, and retains every audio track, subtitle, and attachment. MP4 timed-text subtitles are converted to SRT for MKV compatibility; other subtitle formats are copied. Optional TypeSafe Jev selects among your configured profiles.

## Run on Unraid / Docker

This checkout builds the new image locally; an existing registry `latest` image may still contain version 1.

1. Copy `.env.example` to `.env`. Set your config, media, and scratch paths. Set `PUID`/`PGID` to the account that owns your media (Unraid commonly uses `99:100`). Set `API_KEY` to a long random secret if you want authentication.
2. Create those host directories before starting Docker and make them writable by that UID/GID. Scratch space must fit a complete encode; publication temporarily needs another output-sized file on the destination filesystem.
3. Run `docker compose up -d --build`.
4. First start creates `/config/config.json`. Edit it and run `docker compose restart`.
5. Visit `http://SERVER:5000/health` to confirm startup.

Mount the same media root used by Sonarr and Radarr. If their paths differ inside their containers, configure a mapping:

```json
"pathMappings": [
  { "from": "/media", "to": "." }
]
```

Here `/media/Movies/Film.mkv` maps to `/data/Movies/Film.mkv`. Mapping destinations are either relative to `DATA_DIR` or absolute paths inside it. The longest matching directory prefix wins; mappings are applied once. Traversal and symlinks escaping the media root are rejected. Directory scans do not follow symlinks.

The default output location is `DATA_DIR`. For a separate destination, mount another directory at `/out` and set `OUT_DIR=/out`; the source directory structure is mirrored there. `/config` must be persistent **local storage**, not an NFS/SMB share. Run one service instance per config directory; SQLite locks out a second instance.

### Connect Sonarr / Radarr

Add a **Webhook** connection under Settings → Connect:

- URL: `http://SERVER:5000/sonarr` or `http://SERVER:5000/radarr`
- Method: POST
- Enable import/download and upgrade notifications. They send `Download` events. Other events are acknowledged and ignored.
- If `API_KEY` is set, use any username and the key as the Basic Auth password, or supply the `X-API-Key` header.
- Use the connection's Test button. Test events do not enqueue work.

Append `/compact` or another configured profile name to select it explicitly. `/skip` acknowledges without doing work. Unknown profiles are rejected. New jobs return HTTP 202 with job IDs, including existing IDs for duplicate submissions.

Keep webhook routes on your local network or behind your authenticated reverse proxy. Authentication is optional for local deployments; when enabled, it covers everything except `/` and `/health`. HTTP itself does not encrypt the key.

## Encoding behavior

- `default`: libx265, CRF 24, medium preset, at most 1080p, 10-bit output. All audio/subtitle/attachment tracks and global metadata/chapters are retained. MP4 `mov_text` subtitles are converted to SRT; other subtitle formats are copied. Lower resolution sources retain their size (odd dimensions are padded to even values).
- `compact`: CRF 26, slow preset, at most 720p; all audio tracks become AAC stereo at 192 kbps; HDR is tone-mapped to SDR.
- Existing HEVC sources and names ending in the configured suffix are skipped by default. Set `skipHevc: false` to allow re-encoding HEVC originals.
- HDR is **skipped by the default profile**. Set `profiles.default.hdr` to `"tonemap"` to create 1080p SDR companions from HDR10/HLG and supported Dolby Vision sources. This is a deliberate conversion, not HDR preservation.
- All HDR conversion uses **libplacebo Spline**, perceptual gamut mapping, dynamic peak detection, and Hermite downscaling. Output is 10-bit limited-range BT.709; HDR mastering/light-level metadata is removed. CPU and GPU modes use the same filter settings. The legacy Hable filter chain has been removed.
- A completed file is probed, checked for expected codec/dimensions/duration/track counts, and fully decoded for audio/video errors. The source must remain unchanged throughout encoding.
- By default the output must be at least 5% smaller. Larger or insufficiently smaller encodes are discarded and recorded as skipped.
- Existing destinations are never overwritten, even if another process creates one during encoding. Publishing copies to a hidden file in the destination directory, flushes it, and atomically links it to the final name. The destination filesystem must support hard links (normal Unraid/Linux media filesystems do).
- Audio conversion, cropping, arbitrary ffmpeg arguments, tone-mapping backend, and HDR preservation are not inferred by AI. This version supports the explicit crop and per-stream rules documented below.

### CPU or GPU filtering, one image

The main image includes FFmpeg/libplacebo, the Vulkan loader, and Mesa drivers for
CPU (Lavapipe) and supported AMD/Intel GPUs. **`TONEMAP_BACKEND=cpu` is the default**;
it requires no GPU passthrough. `TONEMAP_BACKEND=gpu` uses a hardware Vulkan GPU.
Decoding defaults to CPU; optional Vulkan Video decoding is described below.
libx265 encoding always remains on the CPU. HDR tone mapping and all resizing
use libplacebo on Vulkan, with Hermite downscaling. SDR resizing preserves the
source color space, transfer and range. SDR jobs needing no resize skip libplacebo.
`TONEMAP_BACKEND` selects the backend for both tone mapping and scaling.

Build the updated image once, then validate or run CPU mode:

```bash
docker compose build
docker compose run --rm --no-deps horadrictube bun dist/index.js --check-media
docker compose up -d
```

`--check-media` runs a tiny synthetic HDR → Spline/Hermite → 10-bit x265 encode, prints
`media.check.passed` with the actual device name, and exits without opening the
queue, changing config, or processing your media. Normal startup runs the same
check if any configured profile enables tone mapping or resizing. Missing
filters/drivers or GPU permissions stop startup with a useful error. GPU mode does **not** silently
switch to CPU. CPU mode pins the Lavapipe driver even when a GPU is exposed.

For **AMD/Intel**, use the included runtime override. Select your host's render
device and its owning group (these values can also go in `.env`):

```bash
export VULKAN_RENDER_DEVICE=/dev/dri/renderD128
export RENDER_GID="$(stat -c '%g' "$VULKAN_RENDER_DEVICE")"
docker compose -f compose.yaml -f compose.gpu.yaml run --rm --no-deps \
  horadrictube bun dist/index.js --check-media
docker compose -f compose.yaml -f compose.gpu.yaml up -d
```

For **NVIDIA**, install/configure the host's NVIDIA Container Toolkit first, then:

```bash
docker compose -f compose.yaml -f compose.nvidia.yaml run --rm --no-deps \
  horadrictube bun dist/index.js --check-media
docker compose -f compose.yaml -f compose.nvidia.yaml up -d
```

The NVIDIA override requests one GPU and the `graphics,video,utility` driver
capabilities; Vulkan needs `graphics`. It selects the supplied EGL-based NVIDIA
Vulkan manifest (`VK_DRIVER_FILES=/app/nvidia_icd.json`) for headless operation.
Driver libraries are supplied by the host
toolkit. See [NVIDIA's runtime documentation](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/docker-specialized.html)
and [Docker's GPU configuration](https://docs.docker.com/compose/how-tos/gpu-support/).
Use only one GPU override. On Unraid, set the equivalent environment variables,
device/group mappings, or NVIDIA GPU assignment in the container template.

To return to CPU mode, keep `TONEMAP_BACKEND=cpu` in `.env` and recreate using only
`docker compose up -d --force-recreate`. Backend changes require recreating the
container, **not rebuilding the image**. To convert HEVC HDR sources, also set
`skipHevc: false` and the chosen profile's `hdr: "tonemap"` in `config.json`.

This covers HDR10/PQ, HLG, and the Dolby Vision cases below on supported Linux
Vulkan stacks; it does not make every GPU/driver compatible. CPU rendering competes with
x265 for cores: `TONEMAP_THREADS` controls Lavapipe's thread count independently
of x265's automatic threading. GPU mode lets libplacebo choose among the
hardware devices exposed to the container. The tone-mapping defaults are:
Spline, peak detection on, smoothing period 20, and contrast recovery off.

### Optional Vulkan Video decoding

Set `DECODE_BACKEND=vulkan` with GPU access to try hardware decoding per file.
Set `TONEMAP_BACKEND=gpu` to keep decoding, cropping, Hermite scaling and any
Spline tone mapping on one Vulkan device. Only the processed frames return to
CPU memory for libx265. SDR jobs needing no resize download at the source bit
depth and use CPU crop/pad filters. With `TONEMAP_BACKEND=cpu`, jobs requiring
scaling or tone mapping also decode on CPU, then filter through Lavapipe.
Crop detection and output validation still use software decoding.

The initial candidates are H.264, HEVC and AV1 with 8/10-bit 4:2:0 pixels.
The GPU/driver must support the actual codec, profile and resolution. Each job
first decodes up to 32 frames through its planned filter chain with a 30-second
timeout. Unsupported hardware or a failing filter graph selects CPU decoding and
logs the reason. If a selected Vulkan encode fails or stalls, its partial file is removed
and the same job starts again with CPU decoding, within the remaining encode
timeout. Scaling and tone mapping retain the explicitly configured backend on
fallback.
Cancellation does not trigger a fallback or another encode.

Dolby Vision Profile 5 uses CPU decoding with the configured CPU or GPU
libplacebo backend for Dolby reshaping and Spline tone mapping.
HDR10-compatible and HLG-compatible Dolby base layers can use Vulkan decoding.
Unsupported codecs/pixel formats use CPU.

`VULKAN_DEVICE` chooses an FFmpeg Vulkan device index or name substring (default
`0`; for example `NVIDIA`). It selects the shared device when Vulkan decoding is
used. Without hardware decoding, GPU Spline retains libplacebo's own selection.
Changes take effect when the container is recreated, without rebuilding it.
Example using the NVIDIA override:

```bash
DECODE_BACKEND=vulkan VULKAN_DEVICE=NVIDIA \
  docker compose -f compose.yaml -f compose.nvidia.yaml up -d
```

`job.decoder` logs the selected path and preflight result;
`job.decoder.fallback` reports a restart after a hardware encode failure or stall.
The plan API also returns `decoder` and `decodeReason`.
`--check-media` checks tone mapping/encoding only; the actual-source preflight
checks Vulkan decoding. Unsupported codecs fall back to CPU. Speed depends on
the source and encoder preset:
accelerating decode/filtering does not remove the CPU x265 bottleneck.

For an explicit hardware test on a development checkout (fails if Vulkan cannot
be used, rather than accepting CPU fallback):

```bash
TONEMAP_BACKEND=gpu VULKAN_DECODE_TEST=1 VULKAN_DEVICE=0 \
  bun test test/integration/decode.test.ts
```

### Dolby Vision to SDR

The goal is ordinary SDR with correctly interpreted colors. Dolby Vision output
and full enhancement-layer reconstruction are not required or attempted.

- **Profile 5:** enable libplacebo's Dolby Vision color reshaping before Spline
  tone mapping. Ordinary color tags can legitimately be unspecified. The probe
  decodes the first 32 video packets and requires parsed Dolby Vision metadata on
  every resulting frame; otherwise conversion is refused, avoiding the common
  green/purple result from treating these pixels as ordinary HDR10. Decoder
  errors during the encode are fatal. This initial check is not a guarantee that
  the rest of a damaged file is valid.
- **Profile 7 with Blu-ray-compatible base (compatibility ID 6):** use the HDR10
  base, ignoring Dolby metadata and the enhancement layer. This produces an SDR
  rendition without promising Dolby's full rendering. Files with a separate
  second video track still hit the existing multiple-video-stream restriction.
- **Profile 8.1 / 8.4 (compatibility IDs 1 / 4):** use the HDR10 / HLG base,
  respectively. Dolby-specific processing is disabled for these base-layer paths.
- Missing or unsupported profile/base-layer combinations are skipped explicitly.

All conversions emit BT.709 SDR and strip Dolby frame metadata. Validation rejects
output that still advertises Dolby Vision. `/plan` and `job.dolbyvision` logs report
`reshape`, `hdr10-base`, or `hlg-base`. Keep `skipHevc: false` and `hdr: "tonemap"`
on the desired profile to process the usual HEVC Dolby Vision files.

See [optional real DV regression samples](test/fixtures/README.md),
[FFmpeg's Dolby metadata handling](https://ffmpeg.org/ffmpeg-filters.html#libplacebo),
and [Dolby's profile/base compatibility definitions](https://ott.dolby.com/OnDelKits/Dolby_Vision_Online_Delivery_Kit/v1/Documentation/Specs/Visio_Profiles/help_files/topics/c_dovi_profiles_public.html).

## Configuration

A basic example is in [`config.example.json`](config.example.json). [`config.server.example.json`](config.server.example.json) illustrates advanced `default` and `dual` profiles with track selection, per-stream encoding, cropping, and filename rules. Unknown settings and invalid values fail startup. Restart after editing; queued jobs use the configuration active when they execute. Delays are fixed when enqueued, using the default profile for `auto` jobs.

| Setting | Default | Meaning |
| --- | --- | --- |
| `version` | `2` | Version 2 format; unversioned legacy profile files are adapted in memory |
| `concurrency` | `1` | Simultaneous encodes (1–16) |
| `defaultProfile` | `default` | Profile for ordinary requests and AI fallback |
| `suffix` | ` HEVC` | Appended to the source stem; must end in HEVC and contain no path separators |
| `pathMappings` | `[]` | Remote webhook paths → local media paths |
| `skipHevc` | `true` | Avoid re-encoding existing HEVC video |
| `minSavingsPercent` | `5` | Required storage reduction (0 still rejects larger files) |
| `maxAttempts` | `3` | Maximum attempts after processing errors |
| `retryDelaySeconds` | `60` | Exponential retry base: 60s, 120s, … |
| `encodeTimeoutSeconds` | `86400` | Timeout for each encode and full-decode validation |
| `maxQueuedJobs` | `10000` | Queue admission limit for pending/running jobs |

Each profile accepts `description`, `crf` (0–40), `preset`, `maxHeight` (144–4320 or `null`), `maxWidth` (2–16384 or `null`), `audio` (`copy` or `aac`), `audioBitrate` (64–512 kbps), `hdr` (`skip` or `tonemap`), and `delaySeconds`. Width/height limits preserve aspect ratio and never upscale. Optional `selection`, `encoder`, `fileRenames`, and per-profile `pathMappings` implement the server rules described below. `extension` accepts `mkv`. Output is always Matroska (`.mkv`) to retain supported subtitle/audio formats. Selected MP4 `mov_text` subtitles are automatically converted to SRT in the same ffmpeg process; text and timing are retained, but some styling/positioning may be lost. Other selected subtitle codecs are copied. Unsupported streams/muxing combinations fail visibly; selected tracks are not silently dropped. Attached cover art and data streams are omitted; multiple main video streams are skipped.

### Encoding threads

Encoder threading is automatic and has no config knobs. The app sizes the x265
worker pool using Bun's `node:os` `availableParallelism()` (which follows the
process's CPU affinity), and x265 chooses how many frames to encode concurrently.
We pass the detected pool size because x265's native NUMA detection produced no
worker pool in some container environments. We do not pass `-threads:v` or
`frame-threads` for queued encodes.

Control CPU allocation through Docker CPU pinning/quotas; `concurrency` still
controls how many jobs run at once. A CPU-time quota limits runtime consumption
but may not reduce the detected worker count. Neither worker count nor automatic
frame threading guarantees full utilization of every allocated CPU.

Old version 2 `threads` and `frameThreads` fields are ignored when loading a
config and can be removed. They no longer restrict encoding performance.
`TONEMAP_THREADS` remains separate: it controls only CPU-based Lavapipe filtering
for both SDR resizing and HDR conversion; GPU mode ignores it. The tiny
`--check-media` startup test deliberately uses one pool/frame thread for its two synthetic frames; queued encodes use the
automatic settings.

### Stream selection and ordered encoding rules

The server example retains the original rule structure:

- `selection.audio` and `selection.subtitle` each accept `primary`, `secondary`, and `allowSecondary`. The first source track matching any primary rule becomes primary. Audio falls back to the first available track; subtitles have no implicit primary. Primary tracks are mapped first and marked default; other selected tracks have default cleared. Forced and other existing dispositions are retained. Without a selection section for a track type, every track of that type is retained, with the subtitle compatibility conversion described above.
- Secondary rules include **all** matching remaining tracks in source order, without duplicates. This matches the original engine, including `dual`'s non-English rule despite its old description saying "first". Add `"limit": 1` to that secondary rule to keep only its first match.
- Rules match `language`, `title`, `forced`, `default`, `primary`, `codec`, `bitrate`, `channels`, `filename`, `width`, `height`, or `hdr`. Supported operators are `==`, `!=`, `>`, `>=`, `<`, `<=`, and case-insensitive `contains`. Clauses within a rule are ANDed. Missing metadata does not match a condition, including `!=`; missing audio bitrate therefore cannot trigger a copy shortcut. Bitrate uses ffprobe's stream value, then Matroska `BPS`/`BPS-eng` tags.
- `encoder` rules are evaluated in order against the **original source metadata** and merged property by property. Later matching rules override earlier settings. Video supports `codec: "libx265"`, `crf`, `preset`, `crop`, `size`, and `tonemap`. Audio supports `copy`, `aac`, `ac3`, or `eac3`, plus `bitrate` and `channels`. Subtitle rules support `copy`. When a later rule selects `copy`, bitrate/channel conversion flags are omitted.
- `size: "1920:-2"` gives the original width-based limit when guarded by `width > 1920`; `-2:1080` and explicit positive width/height pairs are also supported. Rule sizes are applied after cropping, followed by optional `maxWidth`/`maxHeight` bounds. `tonemap: true` uses the same libplacebo SDR pipeline as `hdr: "tonemap"`; ordinary SDR inputs are not tone mapped.
- `crop: true` samples up to ten seconds near 10%, 50%, and 90% of the video and uses the enclosing detected picture area. Detection happens before resizing and tone mapping. Failed or inconclusive detection retains the full frame and logs it. Sampling cannot guarantee that a variable-aspect-ratio title never uses a larger picture area elsewhere; disable the crop rule for those titles. `/plan` performs this detection too, so it may take longer than a simple probe.
- `fileRenames` applies JavaScript regex replacements sequentially to the filename **without its extension**. `$&` and capture substitutions work. A missing HEVC suffix is appended after replacements to keep companions identifiable and avoid overwriting originals. Replacements cannot create directory paths.
- Per-profile `pathMappings` overrides the global mapping list. Explicit profile URLs use that profile's mapping; `auto` uses the default profile's mapping before probing and AI selection. Mapping destinations must be actual container paths inside `DATA_DIR` (or relative to it).

In the advanced configuration example, `default` uses **EAC3 384k/5.1** for primary surround audio and **AAC 96k/stereo** for commentary. `dual` uses **AC3 384k/5.1** for surround tracks in both languages. Both retain the specified AAC/AC3 copy shortcuts, English/forced/SDH subtitle selection, CRF 23/slow, remux cropping, and ordered filename replacements.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `PORT`, `HOST` | `5000`, `0.0.0.0` | Listen address |
| `CONFIG_DIR` | `./config` (`/config` in Docker) | Configuration and SQLite job history |
| `DATA_DIR` | `./data` (`/data` in Docker) | Allowed media root |
| `OUT_DIR` | Same as `DATA_DIR` | Companion destination root |
| `TRANSCODE_DIR` | `./transcode` (`/transcode` in Docker) | Encoding scratch space |
| `CONCURRENCY` | Config value | Optional concurrency override |
| `FFMPEG_PATH`, `FFPROBE_PATH` | `ffmpeg`, `ffprobe` | Executable paths |
| `TONEMAP_BACKEND` | `cpu` | `cpu` (Lavapipe) or `gpu` (hardware Vulkan) for scaling and tone mapping; no silent fallback |
| `TONEMAP_THREADS` | `2` | Lavapipe threads per filtering process, 1–64; independent of x265 |
| `DECODE_BACKEND` | `cpu` | `cpu` or opt-in `vulkan`, with per-file preflight and CPU fallback |
| `VULKAN_DEVICE` | `0` | Vulkan decoding device index or name substring; shared with GPU scaling/tone mapping |
| `VULKAN_CPU_ICD` | Auto-detected | Optional absolute path to Lavapipe's ICD JSON for native/custom installations |
| `API_KEY` | Unset | Bearer token, X-API-Key, or Basic Auth password |
| `TYPESAFE_API_KEY` | Unset | Optional server-side TypeSafe credential |

`PUID`, `PGID`, and the `*_PATH` variables in `.env.example` are Compose substitutions, not variables interpreted by the application. Plain `docker run` users should use `--user UID:GID` and bind mounts directly.

## Optional TypeSafe Jev

Set `TYPESAFE_API_KEY` and `ai.enabled: true`. Routes without a profile then use `auto`; `/manual/auto`, `/sonarr/auto`, and `/radarr/auto` can also request it explicitly. Explicit profile names bypass AI.

Jev answers one bounded Choice question using [TypeSafe's System One API](https://docs.typesafe.ai/api). It selects a name from `ai.candidates` using the profiles' descriptions/basic encoding settings (selection rules, filenames, renames, and path mappings are not sent) and `ai.instructions`. It receives codec, dimensions, audio channels, color metadata, and duration—no video bytes, paths, filenames, track titles, or webhook bodies. It cannot produce commands or filenames. All validation, skip rules, and publishing checks still run locally.

The returned choice must be allowed and meet `ai.minConfidence` (default 0.8). Missing keys, invalid responses, API errors, timeouts, no-match answers, and low confidence use `defaultProfile`. This threshold is a starting policy, not a guarantee of visual quality; evaluate it with your own media. Selection and fallback reasons are recorded in each job's `decision`. API calls may incur charges. Plan previews also call Jev when enabled. The integration uses the documented HTTP contract and is covered by mocked response tests; live calls require your key.

## API and queue operations

Examples assume `API_KEY` is set in your shell. Omit the Authorization header if authentication is disabled.

```bash
# A file or recursively scanned directory; use paths inside DATA_DIR or a configured mapping.
curl -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"path":"Movies"}' http://localhost:5000/manual

# Preview a single file: probes and optionally samples crop, without encoding an output or enqueueing.
curl -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"path":"Movies/Film.mkv"}' http://localhost:5000/plan/default

# Queue counts and recent jobs. Pagination: ?limit=100&offset=0 (maximum limit 500).
curl -H "Authorization: Bearer $API_KEY" http://localhost:5000/jobs
curl -H "Authorization: Bearer $API_KEY" http://localhost:5000/jobs/JOB_ID

# Retry a failed or skipped job after correcting its cause.
curl -X POST -H "Authorization: Bearer $API_KEY" http://localhost:5000/jobs/JOB_ID/retry
```

Jobs move through `queued`, `running`, and `completed`/`skipped`/`failed`. They expose attempts, progress, output path, last message, and the JSON-encoded profile decision. Progress measures encoding; it stays below 100 until validation and publication finish. Status details and errors are available through the API and JSON stdout logs.

Each encoding process has a progress watchdog, starting when FFmpeg launches.
Only increasing `out_time_us` timestamps reset it; repeated, missing, invalid or
backwards progress values do not count as activity or refresh the job's progress
in the database. After **2 minutes** without advancement, `job.encode.warning`
is logged once for that idle period. After **5 minutes**, the process receives
SIGTERM, followed by SIGKILL after five seconds if necessary, and
`job.encode.stalled` records the failure. Vulkan decoding gets the existing CPU
decode fallback, with a fresh watchdog and the remaining overall encode timeout;
the configured scaling/tone-mapping backend and x265 settings stay unchanged.
A CPU stall fails that attempt with an explicit error and follows the normal
`maxAttempts`/retry policy. Shutdown cancellation does not trigger fallback.
The watchdog ends when the encode exits; probing and final validation retain
their existing timeouts.

Submission deduplication uses source path, requested profile, and source file identity/size/modification time. Repeated unchanged submissions return the same job—even after it fails—so use the retry endpoint to request another attempt. Requests received before a source is visible are queued and retried. A changed source can create a new job, but any existing companion is still left untouched. Profiles may produce different filenames through their rename rules. When they resolve to the same destination, the first published companion wins.

SIGTERM/SIGINT stops admission, terminates child processes (force-killing after five seconds if needed), and requeues interrupted work. Startup recovers jobs left running after an abrupt exit. Job-specific temporary files are removed on normal completion/failure and before a recovered job runs. After a hard crash followed by config/path changes, old scratch or hidden `.horadrictube-*.partial` files may need manual cleanup with the service stopped. Job history is retained indefinitely. Back up `config.json` and `jobs.sqlite` while the service is stopped.

## Migrating from version 1

1. Stop the old container. Its in-memory queue cannot be recovered; resubmit any unfinished files.
2. Back up your existing `config.json` and compose/container settings.
3. Keep a supported unversioned v1 profile file, or copy `config.server.example.json` for advanced profile examples. Legacy profiles are strictly validated and adapted in memory, including root-relative path mappings; the file is **never automatically overwritten**. Unsupported settings fail startup rather than being silently discarded.
4. Preserve your `/data`, optional `/out`, and `/transcode` bindings. If the old `/data` and `/out` bindings point to the same location, you only need `/data` now. Make the directories writable by the new container's non-root UID/GID.
5. Unversioned legacy mapping destinations are automatically made relative to `DATA_DIR`: `/Television/` becomes `Television/`, and `/` becomes `.`. The server example already uses this version 2 form, resolving `/media/Series/file.mkv` to `/data/Television/Series/file.mkv` with the default mount. For explicit version 2 configurations, absolute destinations refer to actual container paths inside `DATA_DIR`.
6. Legacy `selection`, the supported ordered `encoder` rules above, `fileRenames`, `extension: "mkv"`, and per-profile `pathMappings` are supported. Legacy `delay` in minutes becomes `delaySeconds`. Legacy files automatically allow HEVC input (`skipHevc: false`); explicit version 2 files must set that flag themselves for HEVC HDR/Dolby Vision conversion. Profiles without rules retain the simpler version 2 behavior. The minimum-savings gate still applies (default 5%).
7. Start the new container, run the webhook Test, inspect `/plan/default` for a representative file, then submit it and inspect `/jobs`.

Legacy `/sonarr/:profile`, `/radarr/:profile`, and `/manual/:profile` URLs remain. Successful queue submissions now return 202 and JSON instead of 204. Selecting a nonexistent profile is an error instead of silently using the default.

## Local development and validation

Bun 1.4.2 is pinned in `.bun-version`, `package.json`, Docker, and CI. The application uses `Bun.serve` for HTTP, `Bun.spawn` for ffmpeg, `bun:sqlite` for durable jobs, `Bun.file`/`Bun.write` for file data, and `bun:test` for tests. Directory operations, file identity checks, exclusive opens, hard links, and fsync use Bun's `node:fs` compatibility API because the corresponding operations are not exposed by `Bun.file`. No Node runtime is required.

Requires Bun **1.4.2+** and ffmpeg/ffprobe with libx265. Resizing and tone mapping additionally require a libplacebo build with Spline/perceptual gamut mapping and a working Vulkan backend. The Docker image uses Debian 13 (trixie) FFmpeg/Mesa packages. Native CPU mode needs `mesa-vulkan-drivers` (Debian/Ubuntu) or `vulkan-swrast` (Arch); native GPU mode needs a compatible Vulkan driver and `TONEMAP_BACKEND=gpu`. Verify with `bun src/index.ts --check-media`.

```bash
bun install --frozen-lockfile
bun run check
bun run test
bun run test:integration  # Real ffmpeg and the configured Vulkan backend; no external services.
bun run build           # Optional bundle; bun start runs TypeScript directly.
bun start
```

Tests cover config validation, path mapping and symlink containment, webhook normalization/auth, atomic batch admission and deduplication, durable recovery, exclusive queue ownership, AI fallback, stream planning, real transcoding, PQ/HLG to SDR conversion, safe publication, and child-process termination. CI runs integration tests against the image's CPU Vulkan stack and smoke-tests startup. Image publishing runs on version tags or manual dispatch and retains the original `ghcr.io/<owner>/<repo>/horadrictube` image path.

Licensed under GPL-3.0, matching the repository's existing `LICENSE` file.
