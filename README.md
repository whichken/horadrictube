# horadric tube
Lightweight webhook-based video transcoding container.

> **IMPORTANT**: This project is in its infancy. It is light on features, changing rapidly, and should not be depended
> on in it's current iteration. With that said, the code should be very approachable, so crack open that IDE and submit
> a PR!

## Quick start

```bash
docker run -p 5000:5000 -v /mnt/user/your_media:/data -v /mnt/user/your_media:/out ghcr.io/whichken/horadrictube/horadrictube
```

## Configuration

### Docker Mounts

#### Required
- **`/data`** - The source directory for your media files. This is where the application will try to read your media from.
- **`/out`** - The destination directory where transcoded media will be written to. This is provided as a separate mount
  to allow for greater flexibility. It's possible that you may want your `/data` and `/out` mounts to bind to the same
  host location.

#### Optional
- `/bin/ffmpeg` - Allows you to override the ffmpeg executable with a custom version. The container comes prepackaged
  with a semi-recent git build from https://johnvansickle.com/ffmpeg/.
- `/bin/ffprobe` - Allows you to override the ffprobe executable with a custom version.
- `/transcode` - The scratch directory for in-progress transcodes. If not provided, it will remain internal to the docker
  container.

### Environment Variables

- **CONCURRENCY** - How many encodes can be executing at the same time. Defaults to 1.

### Encoding Profiles

The most compilcated part of this application is the rules-based engine that dictates the encoding settings.