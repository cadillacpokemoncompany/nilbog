# NilbogLite

NilbogLite is the Windows desktop controller for Whatnot stream monitoring, ADB device routing, coordinate clicking, Discord alerts, and automatic updates.

## GitHub Auto Updates

The app checks this release manifest by default:

```text
https://github.com/cadillacpokemoncompany/nilbog/releases/latest/download/latest.json
```

For each release, upload both files to the same GitHub release:

```text
NilbogLite Setup X.Y.Z.exe
latest.json
```

Create `latest.json` after building the installer:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-github-release-manifest.ps1
```

The installer and manifest are created under:

```text
C:\outputs\NilbogLite
```

## Discord Webhook

Do not commit the Discord webhook to GitHub.

Each PC can use either:

```text
NILBOG_DISCORD_WEBHOOK
```

or this local file:

```text
%APPDATA%\NilbogLite\nilbog-discord-webhook.txt
```

The file should contain only the webhook URL.

## Build

```powershell
npm install
npm run package:win
```

The Windows installer is written to:

```text
C:\outputs\NilbogLite
```
