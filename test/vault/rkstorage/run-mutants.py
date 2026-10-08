"""Disposable-emulator negative controls; restores the sole mutated source in finally."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

serial, destination = sys.argv[1:3]
selected = sys.argv[3:] or ['skip-vacuum', 'skip-sidecar', 'delete-live', 'premature-marker']
assert serial.startswith('emulator-')
repo = Path(__file__).resolve().parents[3]
out = Path(destination).resolve()
out.mkdir(parents=True, exist_ok=True)
source = repo / 'android/app/src/main/java/com/bitpay/wallet/rkstorage/RKStorageCleanup.java'
original = source.read_bytes()
text = original.decode()
adb = os.environ.get('ADB', str(Path.home() / 'Library/Android/sdk/platform-tools/adb'))
env = dict(os.environ, JAVA_HOME='/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home',
           SENTRY_DISABLE_AUTO_UPLOAD='true', NODE_ENV='development')
results = []

def invoke(args, log, cwd=repo):
    with (out / log).open('w') as stream:
        return subprocess.run(args, cwd=cwd, env=env, stdout=stream, stderr=subprocess.STDOUT).returncode

for name in selected:
    if name == 'premature-marker':
        marker_source = repo / 'src/store/vault-rkstorage.ts'
        marker_original = marker_source.read_bytes()
        marker_needle = b'  const state = await captureVaultCleanupState(storage, key);'
        assert marker_original.count(marker_needle) == 1
        marker_mutant = marker_original.replace(marker_needle,
            b'  records.set(RKSTORAGE_RECORD_KEY, COMPLETE); // deliberate test mutant\n' + marker_needle)
        marker_source.write_bytes(marker_mutant)
        try:
            code = invoke(['node','node_modules/.bin/jest','src/store/vault-migration.spec.ts',
                           '--runInBand','--forceExit','--testNamePattern','RK: BUSY remains pending'],name+'-test.log')
            content = (out/(name+'-test.log')).read_text()
            caught = code != 0 and 'Expected: false' in content and 'Received: true' in content
            results.append({'mutation':name,'testExit':code,'caught':caught,
                'originalSha256':hashlib.sha256(marker_original).hexdigest(),
                'mutantSha256':hashlib.sha256(marker_mutant).hexdigest()})
            (out/'results.json').write_text(json.dumps(results,indent=2)+'\n')
            print(json.dumps(results[-1]),flush=True)
            assert caught, 'Premature completion escaped the assertion'
        finally:
            assert marker_source.read_bytes() == marker_mutant, 'Concurrent source edit'
            marker_source.write_bytes(marker_original)
        continue
    if name == 'skip-vacuum':
        assert text.count('db.execSQL("VACUUM");') == 1
        changed = text.replace('db.execSQL("VACUUM");', '; // mutant: omit rebuild')
    elif name == 'skip-sidecar':
        check = 'number(db, "PRAGMA journal_size_limit=0") != 0'
        assert text.count(check) == 2
        changed = text.replace(check, 'false')
        postcondition = 'if (result == Result.CLEANED && !sidecarsFinal(context)) result = Result.SIDECARS;'
        assert changed.count(postcondition) == 2
        changed = changed.replace(postcondition, '; // mutant: skip retained-file verification')
    else:
        guard = '''if (number(db, "SELECT count(*) FROM catalystLocalStorage WHERE key='persist:root'") != 0)
        throw new Stop(Result.LIVE_SOURCE);'''
        assert text.count(guard) == 2
        changed = text.replace(guard, 'db.delete("catalystLocalStorage", "key=?", new String[]{"persist:root"});', 1)
    mutant = changed.encode()
    assert source.read_bytes() == original, 'Concurrent source edit; refusing mutation'
    source.write_bytes(mutant)
    try:
        build = invoke(['./gradlew', ':app:assembleDebug', ':app:assembleDebugAndroidTest', '--no-daemon',
                        '--max-workers=2', '--console=plain', '--project-cache-dir', str(out.parent/'gradle-cache'),
                        '-PreactNativeArchitectures=arm64-v8a'], name+'-build.log', repo/'android')
        assert build == 0, 'Mutant did not compile; not a valid red control'
        for apk in ['debug/app-debug.apk', 'androidTest/debug/app-debug-androidTest.apk']:
            assert invoke([adb,'-s',serial,'install','-r',str(repo/'android/app/build/outputs/apk'/apk)], name+'-install-'+Path(apk).name+'.log') == 0
        if name == 'delete-live':
            command = [adb,'-s',serial,'shell','am','instrument','-w','-r','-e','operation','live',
                       'com.bitpay.wallet.test/com.bitpay.wallet.rkstorage.RKStorageTestRunner']
            code = invoke(command, name+'-test.log')
            log = (out/(name+'-test.log')).read_text()
            caught = 'INSTRUMENTATION_CODE: 1' in log and 'live-source-not-refused' in log
        else:
            code = invoke(['node','test/vault/rkstorage/run-android.cjs',serial,str(out/name),'default'],name+'-test.log')
            caught = code != 0 and 'retained-historical-residue' in (out/(name+'-test.log')).read_text()
        results.append({'mutation':name,'buildExit':build,'testExit':code,'caught':caught,
                        'originalSha256':hashlib.sha256(original).hexdigest(),
                        'mutantSha256':hashlib.sha256(mutant).hexdigest(),
                        'instrumentationAssertionCode': 1 if name == 'delete-live' and caught else None})
        (out/'results.json').write_text(json.dumps(results,indent=2)+'\n')
        print(json.dumps(results[-1]),flush=True)
        assert caught, 'Mutation escaped the asserted oracle'
    finally:
        assert source.read_bytes() == mutant, 'Concurrent source edit; refusing to overwrite it'
        source.write_bytes(original)
assert source.read_bytes() == original
