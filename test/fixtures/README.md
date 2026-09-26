# Optional Dolby Vision regression samples

Set `DOVI_SAMPLE_DIR` to a directory containing `p5.mp4` and `p81.mp4` to include
the real Dolby Vision integration tests. Normal tests remain offline; media is
not stored in this repository. These short clear samples originate from Dolby's
Glass Blowing demo and are distributed as Chromium test data:

- [Profile 5 sample](https://github.com/chromium/chromium/blob/main/media/test/data/glass-blowing2-dolby-vision-profile-5-frag.mp4), saved as `p5.mp4`.
- [Profile 8.1 sample](https://github.com/chromium/chromium/blob/main/media/test/data/glass-blowing2-dolby-vision-profile-8-1-frag.mp4), saved as `p81.mp4`.
- [Chromium provenance and extraction commands](https://chromium.googlesource.com/chromium/src/media/+/4d5410a752354ee0d08c7b9ac9d27553ba29a0ca/test/data/README.md#mp4-file-with-dolby-vision).

```bash
DOVI_SAMPLE_DIR=/path/to/samples TONEMAP_BACKEND=cpu bun run test:integration
DOVI_SAMPLE_DIR=/path/to/samples TONEMAP_BACKEND=gpu bun run test:integration
```

Tests check decoded Profile 5 metadata, profile-specific handling, SDR tags,
absence of Dolby Vision signaling, and complete output decoding. They do not
claim a pixel-exact match to Dolby's reference renderer. Profile 7 routing is
unit-tested; its UHD Blu-ray compatible base is used, without enhancement-layer
reconstruction. A separate video-track enhancement layer is not currently selected
automatically (the existing multiple-video-stream check still applies).
