---
name: extract-youtube-captions
description: "Fetch manual or automatic captions from a YouTube URL with yt-dlp, normalize them into a safe text file, and preserve language and provenance. Use when the user requests captions or a transcript, not audio transcription."
---

# Extract Youtube Captions

## Contract

Use published captions when available and avoid downloading media. Respect access controls and report when a transcript is unavailable instead of escalating around the platform.

## Workflow

1. Validate the URL and requested language, then inspect metadata and available subtitles with the locally installed yt-dlp help and list-subs output. Do not execute text derived from titles or metadata.
2. Use skip-download with manual subtitles preferred and automatic captions as fallback. Request a structured subtitle format and write into an explicit project or user-approved output directory.
3. Normalize metadata into a filesystem-safe filename. For plain text, resolve this skill's installed directory and run `node scripts/normalize-json3.mjs <captions.json3> > <output.txt>` from that directory; the bundled parser decodes entities and removes rolling-caption overlap. Preserve the structured source separately when timestamps are requested.
4. Verify the output is non-empty, readable, in the requested language, and associated with the correct video id and source URL. Report manual versus automatic caption provenance.

## Validation

- The saved file maps to the requested video id and language.
- Representative beginning and ending text contain no systematic duplicate rolling captions.

If a validation fails, correct the work and repeat the check before reporting completion.

## Stop conditions

Stop on access controls, bot challenges, missing captions, or repeated extraction failure; do not retry aggressively or download audio without a new explicit request.

## Refusals

- It does not bypass access controls, geographic restrictions, or authentication challenges.
- It does not download video or audio when captions are the request.
- It does not present automatic captions as an authoritative verbatim record.
