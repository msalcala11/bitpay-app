#!/usr/bin/env python3
"""Kill the scrub at a random moment (SIGKILL), reopen the store in a fresh
process, then let the scrub run again to completion and reopen once more.

Compares the committed scrub (clearAll first) with the non-clearing one.
"""
import os, random, shutil, signal, subprocess, sys, time, collections, re

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(HERE, "scrubfuzz")
DESIGNS = sys.argv[4].split(",") if len(sys.argv) > 4 else ["current", "inplace"]
GAP = "2000"  # microseconds: stand-in for the awaited RNFS.stat bridge round trip


def run(*args):
    return subprocess.run([BIN, *args], capture_output=True, text=True)


def verify(d, root):
    out = run("verify", d, str(root)).stdout.strip()
    m = re.match(r"root=(\S+) logs=(\d) filler=(\d) keys=(\d+) file=(\d+) markers=(\d+)", out)
    if not m:
        return {"root": "UNREADABLE", "logs": 0, "filler": 0, "keys": 0, "file": 0, "markers": -1}
    return {"root": m.group(1), "logs": int(m.group(2)), "filler": int(m.group(3)),
            "keys": int(m.group(4)), "file": int(m.group(5)), "markers": int(m.group(6))}


def main():
    root = int(sys.argv[1])
    trials = int(sys.argv[2])
    seed = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    random.seed(seed)
    tmpl = os.path.join(HERE, f"tmpl-{root}")
    shutil.rmtree(tmpl, ignore_errors=True)
    os.makedirs(tmpl)
    run("seed", tmpl, str(root))
    work = os.path.join(HERE, f"work-{root}")

    for design in DESIGNS:
        # how long an uninterrupted run takes
        times = []
        for _ in range(7):
            shutil.rmtree(work, ignore_errors=True)
            shutil.copytree(tmpl, work)
            t = time.perf_counter()
            run(design, work, str(root), GAP)
            times.append(time.perf_counter() - t)
        duration = sorted(times)[len(times) // 2]

        after_kill = collections.Counter()
        lost_during = collections.Counter()
        after_resume = collections.Counter()
        killed = 0
        leftover_filler = 0
        max_final = 0
        for _ in range(trials):
            shutil.rmtree(work, ignore_errors=True)
            shutil.copytree(tmpl, work)
            p = subprocess.Popen([BIN, design, work, str(root), GAP], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(random.uniform(0, duration * 1.15))
            if p.poll() is None:
                p.send_signal(signal.SIGKILL)
                killed += 1
            p.wait()
            v = verify(work, root)
            after_kill[v["root"]] += 1
            if v["root"] != "intact":
                try:
                    last = open(os.path.join(work, "progress.log")).read().split()[-1]
                except Exception:
                    last = "before-start"
                lost_during[last] += 1
            leftover_filler += v["filler"]
            # next launch: the scrub runs again, uninterrupted
            run(design, work, str(root), GAP)
            w = verify(work, root)
            key = w["root"]
            if w["filler"]:
                key += "+filler-left"
            if w["root"] == "intact" and w["markers"] != 0:
                key += "+markers"
            after_resume[key] += 1
            max_final = max(max_final, w["file"])
        print(f"{design:8s} root={root} B  run takes ~{duration*1000:.0f} ms  trials={trials}  killed mid-run={killed}")
        print(f"   reopened right after the kill : {dict(after_kill)}   (filler left behind in {leftover_filler})")
        print(f"   root not intact when the kill landed during: {dict(lost_during)}")
        print(f"   reopened after the next launch: {dict(after_resume)}   largest final file={max_final}")
    shutil.rmtree(work, ignore_errors=True)
    shutil.rmtree(tmpl, ignore_errors=True)


if __name__ == "__main__":
    main()
