// Scrub experiments on the MMKV core bundled with react-native-mmkv 3.3.1.
// Each subcommand is one process, so every check reopens the store from disk.
// Calls mirror the JS binding in cpp/MmkvHostObject.cpp:
//   set      -> instance->set(std::string, key)
//   delete   -> instance->removeValueForKey(key)
//   clearAll -> instance->clearAll()
//   trim     -> instance->clearMemoryCache(); instance->trim();
//   size     -> instance->actualSize()
// File length comes from stat(), as RNFS.stat would report it.
#include "MMKV.h"
#include <csignal>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <sys/resource.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>

using namespace mmkv;
using std::string;

static const string ROOT = "persist:root", LOGS = "persist:logs", SCRUB = "bitpay.vault.scrub";
static const string MARK = "U2FsdGVkX1";

static long fileSize(const string &p) {
    struct stat st {};
    return stat(p.c_str(), &st) == 0 ? (long) st.st_size : -1;
}
static size_t markers(const string &p) {
    std::ifstream in(p, std::ios::binary);
    string b((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    size_t n = 0, pos = 0;
    while ((pos = b.find(MARK, pos)) != string::npos) {
        n++;
        pos += MARK.size();
    }
    return n;
}
static string legacyRoot(size_t bytes, int gen) {
    string s = "{\"_persist\":\"\\\"";
    while (s.size() < bytes) s += MARK + "gen" + std::to_string(gen) + "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    return s + "\\\"\"}";
}
static string modernRoot(size_t bytes) {
    string s = "{\"_persist\":\"\\\"persist-aesgcm-v1:";
    while (s.size() < bytes) s += "GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG";
    return s + "\\\"\"}";
}
static void jsTrim(MMKV *kv) { // exactly what the binding's trim() does
    kv->clearMemoryCache();
    kv->trim();
}
static int progressFd = -1;
static void step(const char *name) { // survives SIGKILL: plain write(2), no buffering
    if (progressFd >= 0) {
        (void) !write(progressFd, name, strlen(name));
        (void) !write(progressFd, "\n", 1);
    }
}

int main(int argc, char **argv) {
    if (argc < 4) {
        fprintf(stderr, "usage: scrubfuzz <seed|current|inplace|verify> <dir> <rootBytes> [gapMicros] [capBytes] [gens]\n");
        return 2;
    }
    string cmd = argv[1], dir = argv[2];
    size_t rootBytes = std::stoul(argv[3]);
    long gap = argc > 4 ? std::stol(argv[4]) : 0;   // stand-in for the awaited RNFS.stat round trip
    long cap = argc > 5 ? std::stol(argv[5]) : -1;  // max size the file may reach from here on
    int gens = argc > 6 ? std::stoi(argv[6]) : 6;   // legacy rewrites in the seeded history
    string path = dir + "/mmkv.default";
    signal(SIGXFSZ, SIG_IGN);
    MMKV::initializeMMKV(dir, getenv("MMKV_LOG") ? MMKVLogInfo : MMKVLogNone);
    MMKV *kv = MMKV::mmkvWithID("mmkv.default", MMKV_SINGLE_PROCESS);
    if (!kv) return 3;
    string fresh = modernRoot(rootBytes);
    if (cmd == "current" || cmd == "inplace" || cmd == "inplace0" || cmd == "persist") {
        progressFd = open((dir + "/progress.log").c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644);
    }
    auto applyCap = [&] {
        if (cap > 0) {
            struct rlimit lim {(rlim_t) cap, (rlim_t) cap};
            setrlimit(RLIMIT_FSIZE, &lim);
        }
    };

    if (cmd == "seed") {
        kv->set(string("[]"), LOGS);
        for (int g = 1; g <= gens; g++) kv->set(legacyRoot(rootBytes, g), ROOT);
        kv->set(fresh, ROOT); // migrate(): storage.set(ROOT, re-encrypted)
        kv->sync();
        MMKV::onExit();
        printf("seeded file=%ld markers=%zu\n", fileSize(path), markers(path));
        return 0;
    }
    if (cmd == "droproot" || cmd == "dropall") { // a device whose MMKV lost the root (or everything) earlier
        kv->removeValueForKey(ROOT);
        if (cmd == "dropall") kv->removeValueForKey(LOGS);
        kv->sync();
        MMKV::onExit();
        return 0;
    }
    if (cmd == "verify") {
        string back, filler;
        bool has = kv->getString(ROOT, back);
        bool hasFiller = kv->containsKey(SCRUB);
        bool hasLogs = kv->containsKey(LOGS);
        printf("root=%s logs=%d filler=%d keys=%zu file=%ld markers=%zu\n",
               !has ? "MISSING" : (back == fresh ? "intact" : "CHANGED"), (int) hasLogs, (int) hasFiller,
               kv->allKeys().size(), fileSize(path), markers(path));
        return 0;
    }
    if (cmd == "current") {
        // scrub() as committed: clear, check, stat, 64 KiB filler, restore, delete filler
        string root, logs;
        bool hasRoot = kv->getString(ROOT, root), hasLogs = kv->getString(LOGS, logs);
        step("clearAll");
        kv->clearAll();
        if (!kv->allKeys().empty() || kv->actualSize() != 0) return 10;
        step("stat");
        if (gap > 0) usleep((useconds_t) gap);
        long size = fileSize(path);
        applyCap();
        bool covered = size > 0 && size <= 64 * 1024;
        if (covered) {
            step("set-filler");
            if (!kv->set(string(64 * 1024, '0'), SCRUB)) return 11; // JS: set() throws here
        }
        step("restore-root");
        if (hasRoot && !kv->set(root, ROOT)) return 12;
        step("restore-logs");
        if (hasLogs && !kv->set(logs, LOGS)) return 13;
        step("delete-filler");
        kv->removeValueForKey(SCRUB);
        step("done");
        return covered ? 0 : 1;
    }
    if (cmd == "inplace") {
        // non-clearing scrub: drop any leftover filler, trim, measure, overfill, delete, trim
        long peak = fileSize(path);
        if (kv->containsKey(SCRUB)) {
            step("delete-leftover-filler");
            kv->removeValueForKey(SCRUB);
        }
        step("trim-1");
        jsTrim(kv);
        step("stat");
        if (gap > 0) usleep((useconds_t) gap);
        long size = fileSize(path);
        long trimmed = size;
        applyCap();
        if (size <= 0) return 1;
        step("set-filler");
        if (!kv->set(string((size_t) size, '0'), SCRUB)) return 11; // JS: set() throws; root untouched
        if (fileSize(path) > peak) peak = fileSize(path);
        step("delete-filler");
        kv->removeValueForKey(SCRUB);
        step("trim-2");
        jsTrim(kv);
        step("done");
        printf("trimmed=%ld peak=%ld final=%ld\n", trimmed, peak, fileSize(path));
        return 0;
    }
    if (cmd == "inplace0") {
        // non-clearing scrub that never grows the file: after trimming, fill the free
        // tail with a filler sized to fit, leaving room for its own delete record.
        // Entry sizes follow MMKV::doAppendDataWithKey in the pinned core.
        auto varint = [](size_t v) { return v < (1u << 7) ? 1 : v < (1u << 14) ? 2 : v < (1u << 21) ? 3 : v < (1u << 28) ? 4 : 5; };
        const size_t keyBytes = SCRUB.size() + varint(SCRUB.size()); // 19
        auto entrySize = [&](size_t len) { size_t value = len + varint(len); return keyBytes + value + varint(value); };
        const size_t tombstone = keyBytes + 1; // key + empty value
        long peak = fileSize(path);
        if (kv->containsKey(SCRUB)) {
            step("delete-leftover-filler");
            kv->removeValueForKey(SCRUB);
        }
        step("trim-1");
        jsTrim(kv);
        step("stat");
        if (gap > 0) usleep((useconds_t) gap);
        long size = fileSize(path);
        long trimmed = size;
        size_t live = kv->actualSize();
        applyCap();
        if (size <= 0) return 1;
        long space = size - 4 - (long) live;             // CodedOutputData::spaceLeft()
        long target = space - (long) tombstone - 1;       // filler entry must stay strictly below the space left
        bool fits = size > (long) DEFAULT_MMAP_SIZE && target > (long) keyBytes + 2;
        if (fits) {
            size_t len = (size_t) target - keyBytes - 2;  // first guess, then walk to the largest length that fits
            while (entrySize(len + 1) <= (size_t) target) len++;
            while (entrySize(len) > (size_t) target) len--;
            step("set-filler");
            if (!kv->set(string(len, '0'), SCRUB)) return 11;
            if (fileSize(path) != size) return 15;        // the file must not have grown
            step("delete-filler");
            kv->removeValueForKey(SCRUB);
            if (fileSize(path) != size) return 16;
            long uncovered = size - 4 - (long) kv->actualSize();
            printf("uncovered-tail=%ld ", uncovered);
        } else {
            // one-page file (trim may not have compacted it): overfill, which rewrites the whole page
            step("set-filler");
            if (!kv->set(string((size_t) size, '0'), SCRUB)) return 11;
            step("delete-filler");
            kv->removeValueForKey(SCRUB);
        }
        if (fileSize(path) > peak) peak = fileSize(path);
        step("trim-2");
        jsTrim(kv);
        step("done");
        printf("trimmed=%ld peak=%ld final=%ld\n", trimmed, peak, fileSize(path));
        return 0;
    }
    if (cmd == "persist") {
        // ordinary app behaviour for comparison: redux-persist rewriting the root
        for (int i = 0; i < 40; i++) {
            step("set-root");
            string v = fresh;
            if (!kv->set(v, ROOT)) return 12;
        }
        step("done");
        return 0;
    }
    return 2;
}
