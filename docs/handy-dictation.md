# Handy dictation

Hive web composers can insert local Handy transcripts at the cursor. Dictation changes only the current draft. It never submits a task, message, question, plan, or approval. Normal typing works when Handy or browser dictation is unavailable.

## Source and integration

The integration inspected [cjpais/Handy](https://github.com/cjpais/Handy) at commit `82dfab9fda18c4bc24e1f6e56d36474d38eca0bc`. The `LICENSE` file at this revision contains the MIT License. The license copyright is `2025 CJ Pais`.

This revision has no browser HTTP API. Its Tauri commands serve the Handy desktop interface. Its internal engine protocol connects Handy to its own worker process. That protocol is not a stable Hive integration surface.

The supported headless CLI is the reusable integration point. `src-tauri/src/cli.rs` defines `--transcribe-file` and `--json`. `src-tauri/src/lib.rs` validates 16 kHz mono 16-bit PCM WAV input. The same code calls Handy's local `TranscriptionManager::transcribe` batch path. It does not record a microphone, download a model, or call the Handy history API. Handy uses the selected installed Whisper or Parakeet model. The bridge does not copy Handy source code.

The JSON response contains a `text` field and engine metadata. Hive uses only `text`. Hive discards the metadata.

## Setup

Install Handy on the operator computer. Use a build that supports `--transcribe-file` and `--json`. The pinned revision is the reference for this integration.

Install and select a Whisper or Parakeet model through Handy. Do this outside the shared Hive box. The bridge never downloads a model.

Check the installed models:

```bash
handy --list-models
```

The output marks installed models with `✓`.

Start the bridge for the Nexus Hub:

```bash
hive handy-bridge --origin https://nexus.dexima.ai
```

For a standalone Hub on the default port, run:

```bash
hive handy-bridge
```

The default standalone origin is `http://127.0.0.1:7684`. The origin must exactly match the browser origin. It must not contain a path or trailing slash.

The bridge listens only on `127.0.0.1:7685`. It prints a generated pairing token at startup. Keep the process running on the operator computer. Set `HIVE_HANDY_TOKEN` to supply a token with at least 32 characters instead. Set `HANDY_BIN` when the Handy executable is not on `PATH`.

Open the Hub in a browser on the same computer. Select **Dictate** beside a composer. Enter the pairing token, then select **Connect and dictate**. Grant microphone and local-network permission when the browser asks. Select **Stop** after speaking. Review and edit the inserted text before using the existing submit control.

Select **Cancel dictation** to discard the recording or transcription. A late transcript cannot enter the draft after cancellation.

## Privacy and retention

Audio and transcripts are sensitive data. The browser sends audio only to the loopback bridge. No third-party audio service or paid transcription provider receives the audio.

Recording starts after a clear button gesture. It lasts at most 60 seconds. Encoded browser audio is capped at 8 MiB. The browser converts the recording to 16 kHz mono 16-bit PCM WAV before upload.

The bridge accepts at most 1,920,044 WAV bytes. It validates the WAV format and duration again. It runs one transcription at a time. A Handy process times out after 120 seconds. A transcript is capped at 16,000 characters.

The bridge writes one temporary WAV file with mode `0600` inside a temporary directory with mode `0700`. It deletes the directory after success or failure. It retains no audio by default. The headless Handy path used by the bridge does not call Handy's history API.

The bridge does not log audio, transcripts, Handy standard error, or temporary paths. HTTP errors contain generic messages. The browser stores the pairing token only in page memory. Reloading the page clears the token. The browser does not persist audio or transcripts. Existing Hive draft and submission behavior stays unchanged after the operator submits text.

## Bridge security

The bridge binds to loopback only. It requires a bearer token for health checks and transcription. It rejects a missing or different `Origin` header. It also rejects cross-site fetch metadata and non-loopback `Host` values.

Cross-origin preflight succeeds only for the configured Hub origin. The bridge returns no wildcard CORS headers. It supports browser private-network preflight for that same origin. The Hub content security policy allows only `http://127.0.0.1:7685` for this connection.

The Handy child process receives an allowlist of system and model-location environment variables. It does not receive ambient AWS credentials, Hive secrets, or Nexus tokens. The bridge accepts only WAV audio on one transcription endpoint. It cannot execute a supplied command or choose a supplied model.

## Limits and verification

The unit and jsdom browser tests use a deterministic fake engine. They do not run a real microphone or transcription model. The first local execution happens in the bounded pre-push gate. House compute rules prevented a separate RED test run.

Live Handy transcription remains unverified in this lane. Browser microphone capture, encoded-audio decoding, resampling, local-network permission, and the installed-model CLI response need a check on an operator computer. Use a non-sensitive test phrase for that check.

Browser support depends on `MediaRecorder`, `AudioContext`, `OfflineAudioContext`, and microphone APIs. A browser without these APIs shows the unavailable state. Typing remains usable. The bridge supports the Nexus origin or one exact standalone origin at a time.

There is no always-on microphone, global hotkey, production model deployment, model download, automatic submission, or automatic approval.
