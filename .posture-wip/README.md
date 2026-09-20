# Shellius Posture — WIP

Working area for the posture/exposure feature. **Gitignored on purpose** — none
of this is part of the product yet. Move it to `docs/plans/` when the design
settles.

| File | What it is |
|---|---|
| `posture-design.md` | The design: what to build, in what order, and how |
| `shellius-posture-scan.sh` | Standalone scanner — run it on a real server today |
| `test/run-tests.sh` | Fixture harness — iterate on the logic with no server |
| `test/stubs/` | Fake `ss` / `ufw` / `docker` used by the harness |

## Try it

```bash
# on any Linux box — read-only, changes nothing
sudo ./shellius-posture-scan.sh
sudo ./shellius-posture-scan.sh --wide       # every column, ignore terminal width
sudo ./shellius-posture-scan.sh --all        # include loopback-only listeners
sudo ./shellius-posture-scan.sh --json       # the shape the agent would POST

# locally, against synthetic hosts
./test/run-tests.sh
./test/run-tests.sh 1                        # one scenario + its full report
```

**Root is required.** Attribution reads `/proc/<pid>/cgroup` and
`/proc/<pid>/environ` for processes owned by *other* users — that is the whole
point on a shared box, and the kernel only shows it to root. Run without sudo
and the script stops with the exact command to copy. `--unprivileged` overrides
it and accepts partial attribution.

Exit code is `0` when clean, `1` when anything HIGH or above was found, `2` on
a scan error — so it drops into CI or a cron check unchanged.
