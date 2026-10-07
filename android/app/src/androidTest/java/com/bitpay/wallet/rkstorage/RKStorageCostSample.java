package com.bitpay.wallet.rkstorage;

import android.content.Context;
import android.os.Debug;
import android.os.StatFs;
import java.io.File;
import org.json.JSONObject;

/** Test-only 2 ms sampling; volume noise and missed short peaks are reported as limits. */
final class RKStorageCostSample implements AutoCloseable {
  private final Context context;
  private final long freeBefore;
  private volatile boolean running = true;
  private final Thread thread;
  private long maxFiles, minFree, maxNative, maxJava;
  RKStorageCostSample(Context context) {
    this.context = context;
    freeBefore = free(); minFree = freeBefore;
    sample();
    thread = new Thread(() -> {
      while (running) {
        sample();
        try { Thread.sleep(2); } catch (InterruptedException done) { return; }
      }
    });
    thread.setDaemon(true); thread.start();
  }
  private long free() { return new StatFs(context.getFilesDir().getAbsolutePath()).getAvailableBytes(); }
  private synchronized void sample() {
    long files = 0;
    for (String suffix : new String[]{"", "-wal", "-journal", "-shm"}) files += context.getDatabasePath("RKStorage" + suffix).length();
    maxFiles = Math.max(maxFiles, files); minFree = Math.min(minFree, free());
    maxNative = Math.max(maxNative, Debug.getNativeHeapAllocatedSize());
    maxJava = Math.max(maxJava, Runtime.getRuntime().totalMemory() - Runtime.getRuntime().freeMemory());
  }
  @Override public void close() {running = false;thread.interrupt();sample();}
  synchronized JSONObject result() throws Exception {
    return new JSONObject().put("samplePeriodMs", 2).put("peakNamedDatabaseBytes", maxFiles)
        .put("sampledVolumeFreeSpaceDropBytes", Math.max(0, freeBefore-minFree))
        .put("peakNativeAllocatedBytes", maxNative).put("peakJavaUsedBytes", maxJava);
  }
}
