# Pufferfish OpenClaw Channel Plugin

OpenClaw channel plugin for connecting bots to the Pufferfish IM platform.

## Features

- Registers `pufferfish` channel to OpenClaw
- Uses bot-side challenge flow (`/v1/ai-bot/connect`) to exchange runtime token
- Maintains WebSocket connection for inbound messages
- Sends text/image/file replies back to Pufferfish

## Requirements

- Node.js 18+
- OpenClaw CLI installed and available as `openclaw`

## Install

```bash
npm install
npm run build
openclaw plugins install . --link
```

Or use Makefile:

```bash
make install
make build
make install-plugin
```

## Configuration

Configure `channels.pufferfish` in `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "pufferfish": {
      "bots": {
        "my-bot-account": {
          "enabled": true,
          "apiUrl": "https://your-pufferfish-host",
          "botUid": "your-bot-uid",
          "privateKey": "-----BEGIN PRIVATE KEY-----\n<your-private-key>\n-----END PRIVATE KEY-----"
        }
      },
      "botProfilesByBotUid": {
        "your-bot-uid": {
          "systemPrompt": "You are a helpful assistant.",
          "skills": ["skillA", "skillB"]
        }
      }
    }
  }
}
```

You can also copy from the safe template:

```bash
cp openclaw.example.json ~/.openclaw/openclaw.json
```

## Security Notes

- `privateKey` is a secret credential. Keep it only in local runtime config.
- Never commit real private keys, tokens, or production credentials to Git.
- Do not place real secrets in examples, tests, or screenshots.

## Development

```bash
npm run dev
npm test
```

## Open Source Release (GitHub)

Create a public repository on GitHub first, then run:

```bash
git remote add github https://github.com/<org-or-user>/pufferfish-openclaw-channel.git
git push -u github main
```

If your default branch is not `main`, replace it with your branch name.

Recommended checks before first public push:

```bash
npm test
npm run build
git status --short
```

## License

MIT License. See `LICENSE`.
