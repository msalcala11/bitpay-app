#!/usr/bin/env python3
"""Test-only SIGKILL of one owned native worker after its operation marker.
Arguments: delay-seconds progress-file binary operation directory key input cap.
No MMKV file is edited. Counts from this deliberate schedule are not failure rates.
"""
import json, os, pathlib, subprocess, sys, time, resource
wait_seconds=float(sys.argv[1]); progress=pathlib.Path(sys.argv[2])
if progress.exists(): progress.unlink()
env=dict(os.environ,BIP02_PROGRESS=str(progress))
started=time.perf_counter()
p=subprocess.Popen(sys.argv[3:],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
deadline=started+5
while not progress.exists() and p.poll() is None and time.perf_counter()<deadline:
    time.sleep(0.0001)
observed=progress.exists()
if observed:time.sleep(wait_seconds)
killed=p.poll() is None
if killed:p.kill()
p.wait()
usage=resource.getrusage(resource.RUSAGE_CHILDREN)
print(json.dumps({'nativePeakBytes':usage.ru_maxrss if sys.platform=='darwin' else usage.ru_maxrss*1024,'nativeCpuMs':round((usage.ru_utime+usage.ru_stime)*1000,3),'operationMarkerObserved':observed,'killed':killed,'nativeExit':p.returncode,'requestedDelaySeconds':wait_seconds,'elapsedMs':round((time.perf_counter()-started)*1000,3)}))
