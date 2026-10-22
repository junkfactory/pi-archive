# pi-archive

Pi extension that moves stale session files into a per-project `archive/` directory, purges
archives past a retention window, and browses active plus archived sessions from one `/pi-archive`
picker.

It never edits a session file. Archiving is a rename into a subdirectory that pi's session
discovery does not read, so archived sessions disappear from the built-in picker and come back
untouched when you restore them.

## Install

```bash
pi install git:github.com/junkfactory/pi-archive
```

Try it without installing:

```bash
pi --extension /path/to/pi-archive/src/index.ts
```

## Settings

Both keys are top-level entries in `~/.pi/agent/settings.json`:

| Key                        | Default | Meaning                                                                |
|----------------------------|---------|------------------------------------------------------------------------|
| `sessionArchiveDays`       | `7`     | Archive a family when every session in it is older than this many days |
| `sessionArchivePurgeDays`  | `90`    | Delete archived sessions older than this many days                     |

- `0` disables that behavior (no archiving / no purging).
- A negative or non-numeric value also disables the behavior and reports a warning instead of
  silently falling back to the default.
- Only `~/.pi/agent/settings.json` is read — never a repo-local `.pi/settings.json`, so a project
  cannot change retention for the whole machine.

## Layout

Archives live next to the sessions they came from:

```text
~/.pi/agent/sessions/
├── <project>/
│   ├── <timestamp>_<id>.jsonl          # active sessions
│   └── archive/
│       └── <timestamp>_<id>.jsonl      # archived sessions
└── <other-project>/
    └── archive/
```

A forked child stays in its own project's `archive/`, so a family can span several `archive/`
directories. Restoring puts each file back in the directory it came from.

## Usage

```text
/pi-archive          # open the picker
/pi-archive sweep    # sweep now
```

`/pi-archive` is its own command — the built-in `/session` and `/resume` commands are untouched and
unchanged. There is no keyboard shortcut.

A sweep also runs on session start (`reason: "startup"`, interactive runs only). It is silent on
success; warnings and failures surface as notifications. `/pi-archive sweep` always reports a
count, e.g. `archived 3 from 2 families, purged 0`.

### Picker keys

| Key             | Action                                             |
|-----------------|----------------------------------------------------|
| `Tab`           | Cycle scope: `Current` → `All` → `Archived`        |
| `↑` / `↓`       | Move (or `pgup` / `pgdn` for a page)               |
| `Enter`         | Open the selected session                          |
| `u`             | Restore the selected archived family               |
| `a`             | Archive the selected session and its family        |
| `ctrl+d`        | Delete (press `ctrl+d` again to confirm)           |
| `Esc`           | Close the picker (or cancel a pending delete)      |

- `Current` is the sessions of the working directory, `All` is every project, `Archived` is every
  `archive/` directory.
- Selecting the already-open session shows `Session already active` and keeps the picker open.
- Selecting an archived session restores it to its project directory first, then resumes it; `/new`
  afterwards lands next to the restored file, not inside `archive/`.
- `a` is refused for the open session, for a family that contains the open session, and for a family
  another running pi window has open.

## Families

Sessions and their forks are treated as one unit:

- A family archives **only** when every member is stale and none is the active session. A recent
  child keeps an old parent active, and a stale child never moves on its own.
- Archiving a session archives its whole family (same as the sweep), so a manual `a` cannot leave
  children behind in another project directory.
- Restoring (`u`, or `Enter` on an archived row) restores the whole family together, so restoring a
  parent never leaves children archived.
- A **split** family (some members in `archive/`, some still in a project directory) is never
  purged, no matter how old the archived copies are. The sweep report lists it as `split`.

## Purge

Archived files older than `sessionArchivePurgeDays` are deleted with `trash` (macOS
`/usr/bin/trash`). Unattended purge **never** falls back to `unlink`: if `trash` is missing or
fails, the whole purge phase is skipped with one warning and every file is left in place.
Manual deletion in the picker (`ctrl+d`) is interactive and may fall back to `unlink`.

## What it does not change

- **`/usage` still counts archived sessions.** `@tmustier/pi-usage-extension` walks the whole
  sessions tree, including `archive/`, so totals stay historically accurate. Archiving is not
  usage-neutral by accident — it is intentionally not exempted.
- **The built-in `/resume` never shows the archive**, before or after this extension is installed.
  `/resume` and `/session` work exactly as they did; the archive is only reachable through
  `/pi-archive`.
- Archive files are ordinary session files. `pi` will still refuse to open one in place; use
  `/pi-archive` so it is restored first.

## Custom `--session-dir` limitation

The age-based sweep scans only `~/.pi/agent/sessions`. If you start pi with a custom
`--session-dir`:

- the sweep ignores those sessions (they are never auto-archived or auto-purged);
- a manual `a` in the picker still works, and the result is visible under `Archived`, because the
  picker also reads `<sessionDir>/archive`.

## Uninstall / rollback

Stop using the extension by removing its entry from `packages` in `~/.pi/agent/settings.json` (or
by dropping `--extension`); no other package and no pi core code is modified. Deleting the two
settings keys restores the defaults.

Nothing is destroyed by uninstalling: archived sessions stay where they are and can be moved back
with a plain `mv`:

```bash
mv ~/.pi/agent/sessions/<project>/archive/*.jsonl ~/.pi/agent/sessions/<project>/
```

Only purge is irreversible, and it goes to the trash, so `trash` restore covers it. The liveness
registry in `~/.pi/agent/pi-archive/live/` is disposable — stale entries self-prune.

## Development

See [TESTING.md](./TESTING.md) for the local gates and the disposable-agent-dir rehearsal.
