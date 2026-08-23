# mcbench

**How many players can this Minecraft server actually hold?**

Every host advertises RAM. Almost none publish what that RAM does under load, and
the few numbers that exist come with no method attached. mcbench ramps simulated
players against a server and reports TPS — and MSPT where available — at each
step, so the answer is a measurement instead of a marketing claim.

It works against **any** server, including ones you do not administer, because the
default sampling method needs nothing enabled server-side. That is deliberate: a
benchmark only one party can run is not evidence.

```
| Players | Joined | Moving | TPS mean | TPS p5 | TPS min | Samples |
|--------:|-------:|-------:|---------:|-------:|--------:|--------:|
|       1 |      1 |      1 |       20 |     20 |      20 |     150 |
|       5 |      5 |      5 |       20 |     20 |   19.94 |     150 |
|      10 |     10 |      9 |    19.87 |  19.41 |   18.62 |     149 |
|      20 |     20 |     17 |    17.24 |  14.90 |   13.11 |     148 |

Held ≥19.5 TPS (p5) to 5 players; first dip at 10 (p5 19.41).
```

## Read this before quoting any number it produces

- **Simulated clients are not players.** They do not render the world and carry no
  client-side cost. Real players at the same count are heavier. **A player count
  from this tool is a ceiling, not a promise.**
- **Bots wander on a script.** Real players cluster, build, fight and idle in ways
  this does not reproduce.
- **`time` sampling is coarse.** It infers TPS from the server's 20-tick time-sync
  packet, so it averages over 20 ticks and cannot see individual spikes. Use
  `rcon` when you administer the server and want the tick-time distribution.
- **Results are pinned to a moment.** Server software, version, hardware and plan
  limits all move. Record them — the tool makes you — and re-run.

These ship in every report the tool writes, so they travel with the data.

## Install

```bash
npm install
```

Node 20+.

## Use

```bash
# no config file needed
npx mcbench --server.host=play.example.com --ramp=1,5,10,20 --holdSeconds=120

# or keep it in a file
cp mcbench.config.example.json mcbench.config.json
npx mcbench --config=mcbench.config.json

# see the resolved config without running anything
npx mcbench --config=mcbench.config.json --dry-run
```

Any config key can be set on the command line by its dotted path
(`--bots.spreadRadius=800`). CLI flags override the file.

## How TPS is measured

**`time` (default).** A Minecraft server sends a time-sync packet every 20 ticks.
At a healthy 20 TPS those arrive one second apart; at 10 TPS, two seconds apart.
So `TPS = 20 / interval`. Nothing has to be enabled on the server, which means you
can measure a host you are evaluating rather than only one you own. No MSPT.

**`rcon`.** Polls Paper's `/tps` and `/mspt` directly. Accurate, and gives the
tick-time distribution that actually predicts felt lag — but needs RCON enabled,
so it only works on servers you administer.

## Why the defaults look like they do

**Bots move, and they spread out.** Server load is dominated by how many distinct
chunks must stay resident and ticked. A stationary bot pins a handful of chunks and
costs almost nothing; a walking one forces continuous chunk load and unload, which
is the expensive path real players exercise. Twenty bots standing together share one
working set — twenty scattered multiply it. `bots.move=false` exists for
comparison, and will flatter the server badly.

**The report leads with TPS p5, not mean.** A server that averages 20 TPS and dips
to 12 is not a comfortable server. The bad tail is what players notice, so
"comfortable" is defined as the 5th-percentile TPS holding at or above 19.5.

**`moving` is reported next to `joined`.** Bots get wedged in terrain, and a stuck
bot stops loading new chunks. If `moving` is well below `joined`, the run is
understating load and the tool says so.

## Configuration

See `mcbench.config.example.json` for every key with its default. The ones that
change results most:

| Key | Default | Why it matters |
|---|---|---|
| `ramp` | `[1,5,10,15,20]` | Player counts to step through. Must be non-decreasing. |
| `holdSeconds` | `180` | Time at each step. Shorter runs are noisier. |
| `settleSeconds` | `30` | Samples discarded after each step change, while chunks load. |
| `bots.move` | `true` | Turning this off understates load severely. |
| `bots.spreadRadius` | `500` | How far bots disperse. `0` huddles them and understates load. |
| `sampling.method` | `time` | `time` works anywhere; `rcon` is accurate and needs setup. |
| `output.metadata` | — | Echoed into the report. Fill it in or your results are unreproducible. |

## Permission

Only run this against servers you own or have explicit permission to test. It
generates real load and looks exactly like a bot swarm to any operator watching.
Most hosts' terms prohibit load-testing shared infrastructure without notice.

## Licence

MIT. See `LICENSE`.
