# DSH Delete Session

**Permanently delete a conversation and its subagent conversations in DeepSeek Harness Desktop.**

[简体中文](README.md) · [License](LICENSE) · [Contributing](CONTRIBUTING.md)

![Deletion confirmation, using an automatically created test conversation](docs/assets/delete-dialog.png)

This experimental Windows enhancement adds a native **Permanent delete** action to normal and archived conversations. It stops related work, removes local persistence and associated records, and cleans up connected windows and Better Sidebar state.

**This is a runtime bundle plus explicitly installed, version-pinned desktop patches.** It is not a universal, standalone marketplace plugin. Installing dependencies does not patch the application automatically.

## Supported installation

| Component | Requirement |
| --- | --- |
| Desktop | Windows, DeepSeek Harness `0.2.1-rc.5`, `desktop` profile |
| Sidebar | `dsh-better-sidebar 0.28.0`, currently required |
| Build identity | Original SHA-256 values must match [compatibility.json](compatibility.json) |
| Development | Node.js 22+, npm; integration tests use the application's Electron runtime |

Identical version numbers do not guarantee identical binaries. Unsupported builds are rejected. Do not edit checksums to bypass validation. Other DSH releases, standalone web deployments, CLI installations, macOS and Linux desktop installations are not supported by this adapter.

## Deletion scope

The target conversation and nested subagent conversations lose their local log generations, search entries, projections, workspace membership, pin/archive metadata, and exclusive tool output. Attachments are collected only when no other conversation or upload receipt references them. Related drafts, views, tabs and delayed sidebar writes are cleaned up.

Project files, user configuration, shared attachments and independent forks are preserved. **A fork retains its own copied history.** Deleting conversation A does not delete independent conversation B created from A; delete B separately if you also want its copied history removed.

This means application-level file deletion and database cleanup, not forensic disk erasure or deletion from external backups or model providers. Regenerable legacy request-image caches may be invalidated because they lack a reverse reference index. Unsafe or unreadable dependencies cause an error rather than an assumed success.

## Install from source

Run in PowerShell:

```powershell
git clone https://github.com/qiaozheng9/dsh-delete-session.git
cd dsh-delete-session
npm ci
Copy-Item local.config.example.json local.config.json
```

Edit `local.config.json` to point at your existing installation and data root:

```json
{
  "appDir": "D:/software/DeepSeek Harness",
  "home": "D:/DSH/home"
}
```

`appDir` contains `DeepSeek Harness.exe` and `resources/app.asar`; `home` contains `profiles/desktop`. Do not create a new empty data root for installation. A junction at the configured data root is supported. The default home is `~/.dsh`; desktop installation discovery is best effort.

`DSH_APP_DIR` and `DSH_HOME` environment variables override local configuration. Existing installations otherwise reuse recorded targets. The configuration and installation records are ignored by Git.

```powershell
npm run check
npm test
npm run build
npm run prepare:local
npm run verify:runtime
npm run verify:ui
npm run verify:install
```

These checks use isolated data. UI checks use an installed Chromium browser; set `DSH_TEST_BROWSER` if discovery fails. `prepare:local` expects the original, supported desktop files. Builds after installation read the saved originals instead of applying patches twice.

Completely exit the target desktop application from its tray menu, then run:

```powershell
npm run install:local
npm run status
```

Restart DSH. Choose **永久删除** in a conversation menu and confirm the scope. Running conversations show **停止并永久删除**. Cancellation changes nothing; incomplete deletion shows an error and can be retried.

Keep this checkout and `.local/backup/`: the installer needs its state and original program files for removal. Conversation data is not backed up by the installer. Dependencies use the npm mirror configured in `.npmrc`; if unavailable, use `npm ci --registry=https://registry.npmjs.org`.

## Uninstall and updates

Exit DSH completely, then run `npm run uninstall:local`. This restores verified program files and removes this bundle while retaining unrelated profile edits. **It does not restore deleted conversations.** Finish pending deletion before uninstalling.

Uninstall before upgrading DSH or Better Sidebar. Unknown or modified files cause the installer to refuse restoration. A new upstream build needs a reviewed adapter, not a forced patch.

## Development and recovery

Without DSH installed, run `npm run check`, `npm test` and `npm run build:plugin`. GitHub Actions runs these on Windows/Linux with Node.js 22/24. A passing Linux job does not mean Linux desktop installation is supported.

`build:plugin` only compiles the runtime bundle; it does not prepare the required application patches. Full integration tests require the exact supported desktop build. `npm run verify:installed` is a separate, explicit acceptance test: it launches the real desktop profile, creates and deletes a new test conversation, then exits. Do not run it as a routine unit test.

The server accepts conversation IDs, never client-supplied deletion paths. It rechecks descendants, blocks new work, closes writers and acquires the native exclusive lock before cleanup. A minimal journal supports restart/retry; success is emitted only after cleanup completes. Payload-free completion receipts prevent late events from recreating deleted conversations and let reconnecting clients clear old state.

Some adapters depend on private runtime APIs and use `@ts-nocheck`; exact hashes and integration checks are necessary in addition to type checking. This repository excludes installation archives, extracted upstream modules, local state and conversation data. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Ecosystem status

The project can be discovered as a community project, but its manual patch requirement prevents treating it as a standalone, one-click marketplace plugin. No npm package or marketplace listing is claimed. See the [ecosystem notes](docs/ecosystem.md) and official references there.

MIT licensed. An independent community project, unaffiliated with DeepSeek. Third-party attribution: [NOTICE.md](NOTICE.md).
