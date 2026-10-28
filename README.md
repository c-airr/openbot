# OpenBot (airr_ fork)

A fork of [nightly-labs/openbot](https://github.com/nightly-labs/openbot).

This fork has one goal: **one workspace for writing code with many AI subscriptions and platforms.**
You sign in to the providers you already pay for. You use all of them from one app, on your computer
or on your own server.

> This is a personal fork. It is not affiliated with or endorsed by Synthetify Labs, Nightly Labs,
> OpenAI, Anthropic, xAI, Google, Cursor or Cline. The upstream project is the source of the code.

## Goals

- **Many subscriptions, one place.** Use Codex, Claude Code, Grok, Gemini, Cursor, Cline and OpenCode
  side by side. Each agent has its own workspace and conversation. You can switch the provider of an
  agent without losing its history.
- **Code first.** Use the workspace to write, review and run code with several agents at the same time.
- **Local first.** Run it on your own computer or VPS. Keep the data on your machines.
- **No account and no cloud (planned).** The OpenBot account and cloud parts still exist in this fork.
  The goal is to remove them or make them fully optional.

Goals are plans, not finished features. The list of work that is done is in the Git history.

## Account and cloud: current state

This fork still has the upstream account and cloud code. Nothing is removed yet.

- Accounts use one-time email codes. The account API runs on Cloudflare Workers with D1 and R2.
- Cloudflare stores accounts, avatars, host configuration, memberships, invitations and logical
  sessions. It does not store chats, files or commands.
- Remote access (desktop, iPhone app, browser client) uses the upstream Signal and TURN services.
  You can self-host them. See `docs/self-hosting.md`.
- Server mode on a VPS and the Docker image use `openbot login`, which signs in with an email code.

## What comes from upstream

The upstream project is a local-first desktop workspace for persistent AI teammates. It already gives:

- Agents that use Codex, Claude Code, Grok CLI, OpenCode, Gemini, Cursor CLI and Cline CLI
  (through ACP for some providers).
- Custom OpenAI-compatible endpoints and custom ACP agents. It detects local model servers such
  as Ollama and LM Studio.
- Message queues, agent-to-agent messages, file transfers and an embedded browser.
- A headless server mode for a VPS, and a Docker image.

Read the [upstream README](https://github.com/nightly-labs/openbot#readme) for the full feature list,
install steps and commands. The commands in this fork are the same until a change says otherwise.

## Security warning

OpenBot is a development preview. Agents run with `danger-full-access` and without per-action
approval. They can read and change files, run commands and use the network. Run only agents and
tasks that you trust, and keep backups. Read [SECURITY.md](SECURITY.md) first.

## Development

You need [Bun](https://bun.sh/) 1.4.2, Node.js 24 (see `.nvmrc`) and at least one agent CLI.

```
git clone https://github.com/c-airr/openbot.git
cd openbot
bun install --frozen-lockfile
bun run dev
```

## License

PolyForm Noncommercial License 1.0.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
You can use, change and share the code for noncommercial purposes. Commercial use needs a separate
license from the copyright owner (Synthetify Labs). Keep the copyright notices of the upstream project.

Fork maintained by airr_.
