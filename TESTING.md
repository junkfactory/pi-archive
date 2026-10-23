# TESTING

Two layers: fast local gates that must stay green, and a manual rehearsal against a **disposable**
agent directory that never touches the real sessions tree.

## Local gates

Run from the repo root:

```bash
npx tsc --noEmit          # types
npx biome check src tests # lint + format
npx vitest run            # unit suites
```

All three must exit `0`. They are the same checks CI runs (`.github/workflows/ci.yml`), plus
`npx @biomejs/biome check .` in the lint job.

Tests use `mkdtemp` fixtures and injected fakes for every filesystem and subprocess effect
(`listAll`, `trash`, `utimes`, `switchSession`, `readFile`). They never read or write
`~/.pi/agent/`, never run the real `trash`, and restore `PI_CODING_AGENT_DIR` afterwards.

## Dev loop

```bash
pi --extension ./extensions/index.ts
```

Within that session:

- `/pi-archive` opens the picker — three scopes, `Tab` cycles, `↑`/`↓` move, `Esc` returns to the
  editor.
- Type to filter; `Esc` clears; `Tab` keeps the query.
- `/pi-archive sweep` prints a one-line report (`archived N from M families, purged P`) and never
  throws into the handler.
- Startup stays responsive: the auto-sweep runs detached on `session_start` and is silent on
  success.

## Manual rehearsal (user-run checklist)

Everything below runs against a **copy**. Do not point these commands at `~/.pi/agent/` itself, and
never copy `auth.json`.

### 0. Prepare a disposable agent dir

```bash
rm -rf /tmp/pa-agent
mkdir -p /tmp/pa-agent
cp -R ~/.pi/agent/sessions /tmp/pa-agent/
cp ~/.pi/agent/settings.json /tmp/pa-agent/    # sessions + settings only, never auth.json
du -sh /tmp/pa-agent/sessions                   # note the baseline size
```

`PI_CODING_AGENT_DIR` is an existing pi variable, so no code seam is needed for this.

- [ ] `/tmp/pa-agent/sessions` contains the same project dirs as the real tree, and
      `/tmp/pa-agent/auth.json` does **not** exist.

### 1. Startup + picker smoke

```bash
PI_CODING_AGENT_DIR=/tmp/pa-agent \
  pi --extension ./extensions/index.ts
```

- [ ] Startup is not delayed; the auto-sweep produces no success noise.
- [ ] `/pi-archive` renders `Current | All | Archived` and the current scope is preloaded.
- [ ] `Tab` cycles scopes; `Archived` shows rows only after the first sweep has moved something.
- [ ] `All` is hidden when every active session belongs to the working directory; restoring a
      session from another working directory makes it reappear.
- [ ] `Esc` restores the editor with no stray render.

### 2. Sweep, then verify the moves

Inside the same session (or a fresh one with the same env var):

```text
/pi-archive sweep
```

Then, from a second shell:

```bash
diff -r --brief ~/.pi/agent/sessions /tmp/pa-agent/sessions | head -40
```

- [ ] The report names a non-zero family count; the second `/pi-archive sweep` reports
      `archived 0 from 0 families`.
- [ ] Every `diff` line is an expected `<project>/<file>.jsonl → <project>/archive/<file>.jsonl`
      pair. No deletions, no files outside `archive/`, active project dirs otherwise identical.
- [ ] The session you are currently running is still in its project dir (active guard).
- [ ] A fork family moved as a unit: no child is left behind in its project dir, including a child
      that lives in a different project.

### 3. Picker actions

- [ ] `Enter` on an active session switches to it (transcript matches `/resume`); the old session
      file is untouched on disk.
- [ ] `Enter` on the already-open session shows `Session already active` and the picker stays open.
- [ ] `ctrl+a` on a session whose family contains the open session is refused with a status line
      and moves nothing (`diff` stays clean).
- [ ] `ctrl+a` on a session with a fork child removes both rows from `Current` and shows them
      nested under `Archived`.
- [ ] `ctrl+u` on that archived parent restores parent **and** child to their project dirs; both
      leave `Archived`, `Current` shows the fork tree intact.
- [ ] A token that appears only in message text matches the session whose id, name, and cwd do not
      contain it; the results flatten (no fork tree) and are ordered by relevance.
- [ ] A token that appears only in tool output matches nothing; a nonsense query shows
      `No matches for "<q>"` with `Enter` and the keys as no-ops.
- [ ] `ctrl+a` on a filtered list archives the highlighted family and drops its row without
      clearing the query; `ctrl+u` on a filtered `Archived` list restores it the same way.
- [ ] In `All`, each filtered row still shows its shortened cwd before the message count and age.
- [ ] `Enter` on an archived session restores it (mtime now) and resumes it; `/new` afterwards
      creates the next session next to it, not inside `archive/`.
- [ ] `ctrl+d` asks for confirmation; `Esc` cancels; a second `ctrl+d` deletes.
- [ ] `ctrl+d` on a parent deletes the parent **and** its forks in one go; the prompt names the
      count (`Delete 2 sessions …`) and every row leaves the picker.
- [ ] `ctrl+d` on a fork deletes only that fork; the parent and siblings stay.

### 4. Purge, and purge with `trash` absent

First make archives eligible: set a 1-day window and backdate one archived file.

```bash
node -e '
  const p="/tmp/pa-agent/settings.json";
  const s=JSON.parse(require("fs").readFileSync(p,"utf8"));
  s.sessionArchivePurgeDays=1;
  require("fs").writeFileSync(p, JSON.stringify(s,null,2));
'
f=$(find /tmp/pa-agent/sessions -path '*/archive/*.jsonl' | head -1)
touch -t 202001010000 "$f" && ls -l "$f"
```

Then run a sweep with `trash` **absent** from `PATH`. The extension calls `trash` by name, so a
`PATH` without it reproduces the real missing-binary case (no test seam):

```bash
mkdir -p /tmp/pa-path
for d in /bin /usr/bin /usr/local/bin /opt/homebrew/bin; do
  for f in "$d"/*; do
    b=$(basename "$f")
    [ "$b" = trash ] || [ -e "/tmp/pa-path/$b" ] || ln -s "$f" "/tmp/pa-path/$b"
  done
done
env PATH=/tmp/pa-path sh -c 'command -v trash || echo "no trash on PATH"'
PI_CODING_AGENT_DIR=/tmp/pa-agent PATH=/tmp/pa-path \
  pi --extension ./extensions/index.ts
```

- [ ] The pre-flight check prints `no trash on PATH`, confirming the setup.
- [ ] `/pi-archive sweep` purges **0** files, emits one `trash unavailable` warning, and the
      backdated file is still on disk.
- [ ] Re-run with the normal `PATH`: startup or `/pi-archive sweep` purges the backdated archived
      file and `trash` holds it (unattended purge never calls `unlink`).
- [ ] A **split** family is left alone: a family with one member still in a project dir is reported
      as `split` and nothing of it is deleted, regardless of age.

### 5. Two-window liveness (F15)

Use the same disposable dir, first archiving nothing by hand.

Window A and window B are two terminals running the same command:

```bash
PI_CODING_AGENT_DIR=/tmp/pa-agent \
  pi --extension ./extensions/index.ts
```

- [ ] In window A, `/resume` into a session old enough to be stale (mtime older than
      `sessionArchiveDays`).
- [ ] In window B, `/pi-archive sweep` → that family does not move
      (`diff -r ~/.pi/agent/sessions /tmp/pa-agent/sessions` shows it still in place).
- [ ] Quit window A, sweep again in window B → the family now archives.
- [ ] Restarting pi and re-running the sweep does not resurrect or duplicate moves (idempotent).

### 6. Config edge cases

- [ ] `"sessionArchiveDays": 0` → sweep archives nothing, purge still applies.
- [ ] `"sessionArchiveDays": "x"` → nothing archived and one warning (not silently the default).
- [ ] `"sessionArchivePurgeDays": -1` → no purge, warning shown.

### 7. Cleanup

```bash
rm -rf /tmp/pa-agent
```

- [ ] `~/.pi/agent/sessions` was never modified by any of the above; the only writes were under
      `/tmp/pa-agent`.
