"""Run the test-only alert-entry APK on an explicitly named disposable AVD.

python3 test/vault/stage-a/run-alert.py emulator-5584 BIP02_StageB_33e9nnyc /tmp/alert-results
The native/delayed cases expect Chrome's unaccepted first-run screen. No terms
are accepted. Screenshots and hierarchies stay in scratch, never review evidence.
"""
import json
from pathlib import Path
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

serial, avd, destination = sys.argv[1:]
assert re.fullmatch(r"emulator-\d+", serial) and avd.startswith("BIP02_")
output = Path(destination)
output.mkdir(parents=True, exist_ok=True)


def run(args):
    result = subprocess.run(
        ["adb", "-s", serial] + args, capture_output=True, text=True, timeout=30
    )
    if result.returncode:
        raise RuntimeError("Disposable Alert test ADB operation failed")
    return result.stdout


assert run(["emu", "avd", "name"]).splitlines()[0] == avd


def wait_text(label, expected):
    for _ in range(5):
        run(["shell", "rm", "-f", "/sdcard/bip02-alert.xml"])
        run(["shell", "uiautomator", "dump", "/sdcard/bip02-alert.xml"])
        path = output / (label + ".xml")
        run(["pull", "/sdcard/bip02-alert.xml", str(path)])
        tree = ET.parse(path)
        if any(expected in node.get("text", "") for node in tree.iter("node")):
            return tree
        time.sleep(1)
    raise AssertionError("Expected rendered state missing: " + label)


def press(tree, text):
    node = next(n for n in tree.iter("node") if n.get("text", "").lower() == text.lower())
    bounds = list(map(int, re.findall(r"\d+", node.get("bounds"))))
    run(["shell", "input", "tap", str((bounds[0] + bounds[2]) // 2), str((bounds[1] + bounds[3]) // 2)])


cases = []
for mode in ["no-events", "reject", "delayed", "native"]:
    run(["shell", "am", "force-stop", "com.bitpay.wallet"])
    run(["shell", "pm", "clear", "com.bitpay.wallet"])
    (output / "mode.txt").write_text(mode)
    run(["push", str(output / "mode.txt"), "/data/local/tmp/bip02-alert-mode.txt"])
    run(["shell", "run-as", "com.bitpay.wallet", "mkdir", "-p", "files"])
    run(["shell", "run-as", "com.bitpay.wallet", "cp", "/data/local/tmp/bip02-alert-mode.txt", "files/alert-mode.txt"])
    run(["shell", "am", "start", "-n", "com.bitpay.wallet/.MainActivity"])
    tree = wait_text(mode + "-initial", "Wallet data could not be opened")
    pid = run(["shell", "pidof", "com.bitpay.wallet"]).strip()
    press(tree, "Help & Support")
    if mode in ["native", "delayed"]:
        wait_text(mode + "-browser", "Welcome to Chrome")
        run(["shell", "input", "keyevent", "4"])
    time.sleep(2)
    tree = wait_text(mode + "-return", "Wallet data could not be opened")
    press(tree, "Retry")
    wait_text(mode + "-retry", "Synthetic Retry completed")
    result = json.loads(run(["shell", "run-as", "com.bitpay.wallet", "cat", "files/alert-result.json"]))
    assert result["launches"] == 1 and result["retries"] == 1
    if mode == "no-events":
        assert result["changes"] == 0
    assert run(["shell", "pidof", "com.bitpay.wallet"]).strip() == pid
    cases.append({"mode": mode, "nativeAlertAndRetry": True, "sameProcess": True, **result})
    (output / "results.json").write_text(json.dumps({"cases": cases}, indent=2) + "\n")
print(json.dumps({"passed": len(cases), "browserTermsAccepted": False}))
