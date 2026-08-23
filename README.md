# mctickrate

**How many players can this Minecraft server actually hold?**

Every host advertises RAM. Almost none publish what that RAM does under load, and
the few numbers that exist come with no method attached. mctickrate ramps simulated
players against a server and reports TPS — and MSPT where available — at each
step, so the answer is a measurement instead of a marketing claim.

It works against **any** server, including ones you do not administer, because the
default sampling method needs nothing enabled server-side. That is deliberate: a
benchmark only one party can run is not evidence.

A real run — Paper 1.21.11 on a container capped to 4 GB / 2 CPUs, superflat
world, AMD Ryzen 7 9800X3D:

```
| Players | Joined | Moving | TPS mean | TPS p5 | TPS min | Samples |
|--------:|-------:|-------:|---------:|-------:|--------:|--------:|
|      10 |     10 |     10 |    19.99 |  19.95 |   19.84 |      52 |
|      20 |     20 |     20 |    19.99 |  19.92 |   19.86 |      52 |
|      30 |     30 |     30 |    19.99 |  19.94 |   19.87 |      52 |
|      40 |     40 |     40 |    19.95 |  19.68 |   19.41 |      52 |

Held ≥19.5 TPS (p5) at every tested count, up to 40 players — the ceiling is
above this ramp, so test higher.
```

Note what that output does *not* say. It does not say "this plan holds 40
players" — it says the ceiling was not found, because the ramp stopped at the
server's `max-players`. The first real strain is visible at 40 (p5 drops from
19.94 to 19.68) but the tool will not extrapolate for you.

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
- **Bots wedge on natural terrain — run the target on a superflat world.**
  On generated terrain, walking clients fall off ledges and stick, stop loading
  chunks, and stop costing the server anything. Measured: 0 of 5 bots still
  moving. On a superflat world (`level-type=minecraft:flat`) the same run held
  **6 of 6 moving**. The tool reports `moving` next to `joined` either way —
  **if `moving` is well below `joined`, the run is not measuring what it
  claims.**
- **There is a Minecraft version ceiling.** mineflayer's protocol data lags new
  releases. Measured 2026-08-22, the newest it will connect to is **1.21.11** —
  it refuses 26.x with *"Server version is not supported"*. You cannot benchmark
  a host running a version newer than that until support lands upstream.

These ship in every report the tool writes, so they travel with the data.

## Install

```bash
npm install
```

Node 20+.

## Use

```bash
# no config file needed
npx mctickrate --server.host=play.example.com --ramp=1,5,10,20 --holdSeconds=120

# or keep it in a file
cp mctickrate.config.example.json mctickrate.config.json
npx mctickrate --config=mctickrate.config.json

# see the resolved config without running anything
npx mctickrate --config=mctickrate.config.json --dry-run
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

## How this compares to other tools

Minecraft load-testing splits into two categories. mctickrate sits deliberately between
them, and it is genuinely worse than both at some things — worth knowing before you
pick one.

### Bot swarms generate load but do not measure it

[BotMark](https://github.com/Pumpkin-MC/BotMark),
[mc-bots](https://github.com/crpmax/mc-bots),
[StressTest-MC](https://github.com/GaetanOff/StressTest-MC),
[stress-bot](https://github.com/sim0n/stress-bot),
[minecraft-stress-test](https://github.com/PureGero/minecraft-stress-test),
[Minecraft-Bot-Stress-Tester](https://github.com/tino964MC/Minecraft-Bot-Stress-Tester)
and [SoulFire](https://soulfiremc.com) all spawn simulated players, and several do it
better than mctickrate does — web UIs, SOCKS5 proxy support, YAML scenario scripting,
more sophisticated bot behaviour.

What they do not do is tell you what happened. BotMark's documentation is typical:
it describes bot count, delays, movement and physics, with no TPS or MSPT reporting
anywhere. You generate the load, then go and observe the server by some other means,
and correlate the two by hand. That requires access to the server.

### Benchmark plugins measure precisely, but only on servers you run

[ServerBenchmark](https://modrinth.com/plugin/serverbenchmark),
[MCBenchmark](https://modrinth.com/plugin/mctickratemark) and
[MCBench-Pro](https://github.com/chatchaiGithub/MCBench-Pro) install server-side and
read real TPS, MSPT, GC and I/O counters. **This is more accurate than anything a
client can infer, and if you administer the server you should probably use one.**

The limit is structural: a plugin cannot be installed on a host you are evaluating.
So they cannot answer "is provider A faster than provider B for my workload?"

ServerBenchmark comes closest to mctickrate's output — it advertises "player capacity
recommendations" — but derives them from weighted hardware scoring rather than from
measured load. MCBench-Pro generates synthetic CPU load to measure recovery time,
which is a different question from how the server behaves with players on it.

### What mctickrate does differently

It generates the load **and** measures the result in one run, and the default sampling
path needs nothing installed server-side — TPS is inferred from the server's own
20-tick time-sync packet, which every server sends to every client.

That single property is the reason this tool exists. It means you can run the same
benchmark, unmodified, against a host you are shopping for and the host you already
pay, and compare the numbers. Neither category above can do that.

|  | Bot swarms | Benchmark plugins | mctickrate |
|---|---|---|---|
| Generates realistic player load | ✅ | ❌ | ✅ |
| Reports server performance | ❌ | ✅ | ✅ |
| Works without server-side access | ✅ | ❌ | ✅ |
| Accurate MSPT / tick distribution | ❌ | ✅ | only via RCON |
| Can compare two providers | ❌ | ❌ | ✅ |

### Where mctickrate is worse

- **Coarser measurement.** The default method averages over 20 ticks and cannot see
  individual spikes. A server-side plugin reads the real tick loop. If you administer
  the server, `sampling.method=rcon` narrows the gap, but a plugin still wins.
- **Simpler bots.** No proxy support, no scenario scripting, no web UI, no combat or
  building behaviour. Bots walk, turn and jump.
- **Young and unproven.** The tools above have users. This one is new.

Use a plugin when you own the server and want the truth about its tick loop. Use a bot
swarm when you only need load and already have your own observability. Use mctickrate
when you need a number you can compare across servers you do not control.

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

### Pre-generate the world, or later steps will look artificially cheap

A rising ramp has a confound that is easy to miss. Each step sends bots into ground
the previous steps have already generated, so the server does progressively less
world-generation work as the run goes on — even though player count is climbing.
Later steps therefore measure a **warmer, cheaper** server than earlier ones.

This is not theoretical. A measured run produced:

| Players | TPS p5 |
|---:|---:|
| 80 | 19.54 |
| 100 | 18.46 |
| **120** | **18.85** ← better than 100 |

120 players scored better than 100. Load did not fall; the world had simply been
mostly generated by then, so the cost of generating it had already been paid.

**Pre-generate the play area before benchmarking** — the [Chunky](https://modrinth.com/plugin/chunky)
plugin will do it (`chunky radius 1000; chunky start`, wait for it to finish). That
removes world generation from the measurement entirely and leaves what you actually
want: the cost of keeping chunks resident and ticking entities for N players.

Without it, read a non-monotonic result as evidence of this effect rather than as a
real recovery, and treat the highest steps as the least trustworthy.

### Run the target on a superflat world

This matters enough to be a setup requirement rather than a footnote.

On natural terrain a bot walks a few seconds, drops off a ledge and then sits at
exactly zero displacement with `onGround=false` while still holding `forward`.
Measured against a live server: **0 of 5 bots still moving**. The harness detects
the stall and tries to free it — reverse heading, hop, brief reverse walk — but
recovery on real terrain is unreliable, and a wedged bot generates almost no
load, so the run silently measures an idle server with statues on it.

The same harness against a superflat world held **6 of 6 moving**. Set this on
the server under test:

```properties
level-type=minecraft:flat
generate-structures=false
```

It also makes runs more reproducible — every bot walks identical ground — at the
cost of understating per-chunk generation expense relative to real terrain. That
trade is worth taking: a moving bot on flat ground generates far more genuine
load than a stuck one in hills.

If you cannot change the world (benchmarking someone else's server), read
`moving` in the report before trusting any number in it.

## Configuration

See `mctickrate.config.example.json` for every key with its default. The ones that
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
