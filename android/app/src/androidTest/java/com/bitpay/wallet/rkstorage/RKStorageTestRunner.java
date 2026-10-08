package com.bitpay.wallet.rkstorage;

import android.app.Instrumentation;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.Bundle;
import android.os.Debug;
import android.os.Process;
import android.os.SystemClock;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Callback;
import com.facebook.react.bridge.PromiseImpl;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.WritableArray;
import com.reactnativecommunity.asyncstorage.AsyncStorageModule;
import com.reactnativecommunity.asyncstorage.ReactDatabaseSupplier;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/** Only installed in the disposable test APK. All fixtures are public throwaway data. */
public final class RKStorageTestRunner extends Instrumentation {
  private Bundle args;
  private Context context;
  private ReactApplicationContext react;
  private AsyncStorageModule provider;
  private final Map<String, String> live = new LinkedHashMap<>();
  private JSONObject result = new JSONObject();

  @Override public void onCreate(Bundle args) { super.onCreate(args); this.args = args; start(); }
  @Override public void onStart() {
    // handleBindApplication calls Application.onCreate after instrumentation's
    // onCreate. Do not race SoLoader initialization in a fresh process.
    waitForIdleSync();
    context = getTargetContext();
    react = new com.facebook.react.bridge.BridgeReactContext(context);
    try {
      live.put("library-empty", "");
      live.put("clé-日本語-🧭", "Unicode key");
      live.put("library-unicode", "🧭 café 日本語 e\u0301");
      live.put("library-text", "U2FsdGVkX1 not a wallet; opaque non-JSON library data");
      live.put("library-nul", "a\u0000b");
      live.put("library-large", repeatText("é",350000));
      provider = new AsyncStorageModule(react);
      String operation = args.getString("operation", "normal");
      if (operation.equals("syscall-checkpoint")) args.putString("mode","wal");
      if (operation.equals("large") || args.getString("large", "false").equals("true")) live.put("library-large", repeatText("é",1200000));
      if (operation.equals("empty")) live.clear();
      if (operation.startsWith("react-")) {
        if (java.util.Arrays.asList("react-seed","react-base-only","react-async-only","react-empty-import").contains(operation)) {
          reset();
          queue(() -> {scalar(ReactDatabaseSupplier.getInstance(context).get(), "PRAGMA secure_delete=OFF");return true;});
        }
        result = RKStorageReactTest.run(this, operation);
      } else if (operation.equals("seed")) {
        seed();
        result.put("seeded", true);
      } else if (operation.equals("verify")) {
        exact();
        result.put("preserved", true);
        normalAccess();
      } else if (operation.equals("absent")) {
        reset();
        result.put("status", bridge("inspect"));
        check(!context.getDatabasePath("RKStorage").exists(), "absent-created-database");
      } else if (operation.equals("orphan") || operation.equals("corrupt")) {
        reset();
        File file = context.getDatabasePath(operation.equals("orphan") ? "RKStorage-wal" : "RKStorage");
        byte[] bytes = repeatText("invalid synthetic database input",100).getBytes(StandardCharsets.UTF_8);
        Files.write(file.toPath(), bytes);
        result.put("status", bridge("clean"));
        check(java.util.Arrays.equals(bytes, Files.readAllBytes(file.toPath())), "unsafe-corruption-deletion");
      } else if (operation.equals("queue-timeout")) {
        seed();
        java.util.concurrent.CountDownLatch entered = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.CountDownLatch release = new java.util.concurrent.CountDownLatch(1);
        CompletableFuture<Void> held = new CompletableFuture<>();
        ReactDatabaseSupplier.DATABASE_EXECUTOR.execute(() -> {
          try (Cursor cursor = ReactDatabaseSupplier.getInstance(context).get().rawQuery("SELECT key FROM catalystLocalStorage", null)) {
            check(cursor.moveToFirst(), "cursor-empty");entered.countDown();release.await(10, TimeUnit.SECONDS);
            check(ReactDatabaseSupplier.getInstance(context).get().isOpen(), "queued-timeout-closed-owner");held.complete(null);
          } catch (Throwable error) {held.completeExceptionally(error);}
        });
        check(entered.await(5,TimeUnit.SECONDS), "owner-not-entered");
        try {result.put("status",bridge("clean"));check(result.getString("status").equals("BUSY"),"queue-not-deferred");}
        finally {release.countDown();}
        held.get(10,TimeUnit.SECONDS);exact();normalAccess();result.put("preserved",true);
      } else if (operation.equals("concurrent") || operation.equals("late-live")) {
        seed();
        java.util.concurrent.CountDownLatch entered = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.CountDownLatch release = new java.util.concurrent.CountDownLatch(1);
        CompletableFuture<String> maintenance = new CompletableFuture<>();
        final CompletableFuture<String> ownedMaintenance = maintenance;
        if (operation.equals("concurrent")) {
          ReactDatabaseSupplier.DATABASE_EXECUTOR.execute(() -> {
            try {ownedMaintenance.complete(RKStorageCleanup.maintain(context, phase -> {
              if (phase.equals("before-vacuum")) {entered.countDown();try {release.await(10,TimeUnit.SECONDS);}catch(InterruptedException stop){throw new IllegalStateException();}}
            }).name());}catch(Throwable failure){ownedMaintenance.completeExceptionally(failure);}
          });
        } else {
          ReactDatabaseSupplier.DATABASE_EXECUTOR.execute(() -> {entered.countDown();try{release.await(10,TimeUnit.SECONDS);}catch(InterruptedException stop){Thread.currentThread().interrupt();}});
        }
        check(entered.await(5,TimeUnit.SECONDS),"maintenance-not-entered");
        CompletableFuture<Void> write = putAsync(operation.equals("late-live")?"persist:root":"queued-before-close", operation.equals("late-live")?fixture("plain"):"first");
        if (operation.equals("late-live")) maintenance = bridgeAsync("clean");
        provider.invalidate();
        provider = new AsyncStorageModule(new com.facebook.react.bridge.BridgeReactContext(context));
        CompletableFuture<Void> second = putAsync("queued-after-close", "second");
        release.countDown();
        String status = maintenance.get(30,TimeUnit.SECONDS);write.get(30,TimeUnit.SECONDS);second.get(30,TimeUnit.SECONDS);
        check(status.equals(operation.equals("late-live")?"LIVE_SOURCE":"CLEANED"),"concurrent-status");
        check("second".equals(get("queued-after-close")),"reopen-write-lost");
        if(operation.equals("concurrent")) check("first".equals(get("queued-before-close")),"queued-write-lost");
        else check(fixture("plain").equals(get("persist:root")),"late-live-lost");
        exact();result.put("status",status);result.put("preserved",true);
      } else if (operation.equals("unsupported-lock") || operation.equals("unsupported-mode")) {
        seed();
        String pragma = operation.equals("unsupported-lock") ? "locking_mode" : "journal_mode";
        String value = operation.equals("unsupported-lock") ? "exclusive" : "memory";
        queue(() -> scalar(ReactDatabaseSupplier.getInstance(context).get(),"PRAGMA "+pragma+"="+value));
        result.put("status",bridge("clean"));
        check(result.getString("status").equals(operation.equals("unsupported-lock")?"BUSY":"UNSUPPORTED"),"unsupported-not-deferred");
        check(queue(() -> scalar(ReactDatabaseSupplier.getInstance(context).get(),"PRAGMA "+pragma)).equals(value),"unsupported-settings-changed");
        exact();result.put("preserved",true);
      } else if (operation.equals("busy-checkpoint")) {
        seed();
        queue(() -> {ReactDatabaseSupplier.getInstance(context).get().enableWriteAheadLogging();return true;});
        put("library-before-reader", "committed");
        SQLiteDatabase other = SQLiteDatabase.openDatabase(context.getDatabasePath("RKStorage").toString(), null,
            SQLiteDatabase.OPEN_READWRITE | SQLiteDatabase.ENABLE_WRITE_AHEAD_LOGGING);
        other.beginTransactionNonExclusive();
        try (Cursor cursor = other.rawQuery("SELECT key FROM catalystLocalStorage",null)) {
          check(cursor.moveToFirst(), "reader-empty");
          result.put("status",bridge("clean"));
          check(other.isOpen(), "foreign-owner-closed");
          check(result.getString("status").equals("BUSY"), "checkpoint-not-deferred");
        } finally {other.endTransaction();other.close();}
        exact();normalAccess();check("committed".equals(get("library-before-reader")), "checkpoint-lost-row");
        result.put("preserved",true);
      } else if (operation.equals("denied")) {
        seed();
        File main=context.getDatabasePath("RKStorage");
        queue(() -> {ReactDatabaseSupplier.getInstance(context).closeDatabase();return true;});
        byte[] before=Files.readAllBytes(main.toPath());
        android.system.Os.chmod(main.toString(),0);
        try {result.put("status",bridge("clean"));check(!result.getString("status").equals("CLEANED"),"denied-open-cleaned");}
        finally {android.system.Os.chmod(main.toString(),0600);}
        check(java.util.Arrays.equals(before,Files.readAllBytes(main.toPath())),"denied-input-changed");exact();result.put("preserved",true);
      } else {
        if (!operation.equals("clean") && !operation.equals("clean-live") && !operation.equals("kill")) seed();
        if (operation.equals("hot")) {
          put("persist:root",fixture("plain"));
          queue(() -> {
            SQLiteDatabase db=ReactDatabaseSupplier.getInstance(context).get();
            db.execSQL("PRAGMA cache_size=1");db.beginTransaction();
            db.delete("catalystLocalStorage","key=?",new String[]{"persist:root"});
            db.execSQL("UPDATE catalystLocalStorage SET value=? WHERE key='library-large'",new Object[]{repeatText("uncommitted",90000)});
            Process.killProcess(Process.myPid());return true;
          });
        }
        if (operation.equals("live")) put("persist:root", fixture("plain"));
        Map<String,String> beforeMaintenance = snapshot();
        long start = SystemClock.elapsedRealtime();
        RKStorageCostSample costs = new RKStorageCostSample(context);
        String status;
        if (operation.equals("kill")) {
          if (args.getString("mode", "").equals("wal")) queue(() -> {ReactDatabaseSupplier.getInstance(context).get().enableWriteAheadLogging();return true;});
          status = queue(() -> RKStorageCleanup.maintain(context, phase -> {
            Bundle progress = new Bundle();progress.putString("sqlitePhase", phase);sendStatus(0,progress);
            if (phase.equals(args.getString("phase"))) Process.killProcess(Process.myPid());
            if (phase.equals("before-vacuum") && args.getString("phase", "").equals("timed-vacuum")) {
              new Thread(() -> {try {Thread.sleep(Integer.parseInt(args.getString("delay", "1")));}catch(InterruptedException stop){return;}Process.killProcess(Process.myPid());}).start();
            }
          }).name());
        } else if (operation.equals("full")) {
          File reserve = new File(context.getFilesDir(), "rkstorage-test-reserve");
          try {
            status = queue(() -> RKStorageCleanup.maintain(context, phase -> {
              if (phase.equals("before-vacuum")) {
                long bytes = new android.os.StatFs(context.getFilesDir().toString()).getAvailableBytes() - 65536;
                check(bytes > 0 && bytes < 8L*1024*1024*1024, "full-disk-test-bound");
                try (java.io.RandomAccessFile f = new java.io.RandomAccessFile(reserve, "rw")) {
                  android.system.Os.posix_fallocate(f.getFD(), 0, bytes);
                  result.put("reserveAllocationSucceeded", true);
                  result.put("freeBytesAtVacuum", new android.os.StatFs(context.getFilesDir().toString()).getAvailableBytes());
                } catch (Exception failure) {throw new IllegalStateException();}
              }
            }).name());
          } finally {check(!reserve.exists() || reserve.delete(), "reserve-cleanup-failed");}
          check(!status.equals("CLEANED"), "full-disk-fault-not-exercised");
        } else if (operation.startsWith("syscall-")) {
          String kind = operation.substring("syscall-".length());
          check(java.util.Arrays.asList("sync","write","truncate","checkpoint").contains(kind), "unknown-syscall-fault");
          File arm = new File(context.getFilesDir(),"rk-test-arm");
          File fired = new File(context.getFilesDir(),"rk-test-fired");
          fired.delete();
          if (kind.equals("checkpoint")) queue(() -> {ReactDatabaseSupplier.getInstance(context).get().enableWriteAheadLogging();return true;});
          try {
            status = queue(() -> RKStorageCleanup.maintain(context, phase -> {
              if (phase.equals(kind.equals("checkpoint") ? "before-checkpoint" : "before-vacuum")) {
                try {Files.write(arm.toPath(), new byte[]{(byte)(kind.equals("sync")?'s':kind.equals("truncate")?'t':'w')});}
                catch(Exception failure){throw new IllegalStateException();}
              }
            }).name());
          } finally {arm.delete();}
          check(fired.exists(), "syscall-not-injected");
          result.put("injectedFileClass", new String(Files.readAllBytes(fired.toPath()), StandardCharsets.UTF_8));
          check(!status.equals("CLEANED"), "failed-syscall-reported-cleaned");
        } else if (operation.equals("fault")) {
          status = queue(() -> RKStorageCleanup.maintain(context, phase -> {
            if (phase.equals(args.getString("phase"))) throw new IllegalStateException("synthetic-phase-fault");
          }).name());
        } else {
          status = bridge("clean");
        }
        costs.close();
        result.put("sampledCosts", costs.result());
        result.put("status", status);
        metadata();
        result.put("finalJournalMode", queue(() -> scalar(ReactDatabaseSupplier.getInstance(context).get(), "PRAGMA journal_mode")));
        result.put("pageCount", queue(() -> scalar(ReactDatabaseSupplier.getInstance(context).get(), "PRAGMA page_count")));
        result.put("pageSize", queue(() -> scalar(ReactDatabaseSupplier.getInstance(context).get(), "PRAGMA page_size")));
        result.put("durationMs", SystemClock.elapsedRealtime() - start);
        result.put("nativeAllocatedBytes", Debug.getNativeHeapAllocatedSize());
        result.put("javaUsedBytes", Runtime.getRuntime().totalMemory() - Runtime.getRuntime().freeMemory());
        if (operation.equals("live") || operation.equals("clean-live")) {
          check(status.equals("LIVE_SOURCE"), "live-source-not-refused");
          check(get("persist:root").equals(fixture("plain")), "live-source-altered");
        } else if (!operation.equals("fault") && !operation.equals("full") && !operation.startsWith("syscall-")) {
          check(status.equals("CLEANED"), "cleanup-not-complete-" + status);
        }
        check(beforeMaintenance.equals(snapshot()), "native-live-map-changed");
        exact();
        result.put("preserved", true);
        // Capture metadata at the production success boundary, before additional normal writes.
        metadata();
        // Host scans the production return boundary before any normal write can
        // finalize a retained journal. A separate fresh-process verify tests writes.
        if (operation.equals("normal")) {
          check(bridge("clean").equals(status), "repeat-outcome-changed");
          result.put("repeatJoined", true);
        }
      }
      if (!operation.equals("absent") && !operation.equals("orphan") && !operation.equals("corrupt"))
        result.put("sqlite", queue(() -> scalar(ReactDatabaseSupplier.getInstance(context).get(), "SELECT sqlite_version()")));
      result.put("api", android.os.Build.VERSION.SDK_INT);
      Bundle output = new Bundle(); output.putString("results", result.toString());
      finish(-1, output);
    } catch (Throwable failure) {
      Bundle output = new Bundle();
      // No arbitrary exception, source value, SQL parameter, or native path in output.
      output.putString("partial", result.toString());
      output.putString("failureClass", failure.getClass().getSimpleName());
      Throwable root = failure;
      while (root.getCause() != null) root = root.getCause();
      output.putString("rootClass", root.getClass().getSimpleName());
      if (root.getStackTrace().length > 0) output.putString("frame", root.getStackTrace()[0].toString());
      output.putString("case", args.getString("operation", "normal"));
      if (failure instanceof AssertionError) output.putString("assertion", failure.getMessage());
      finish(1, output);
    }
  }

  private void reset() throws Exception {
    queue(() -> {ReactDatabaseSupplier.getInstance(context).closeDatabase(); context.deleteDatabase("RKStorage"); return true;});
  }
  private String fixture(String name) throws Exception {
    try (var stream = getContext().getAssets().open("legacy-14.32.json")) {
      JSONObject all = new JSONObject(new String(readBytes(stream), StandardCharsets.UTF_8));
      return all.getJSONObject("cases").getJSONObject(name).getString("raw");
    }
  }
  private void seed() throws Exception {
    reset();
    String page = args.getString("page", "4096");
    check(page.equals("4096") || page.equals("16384"), "invalid-test-page");
    queue(() -> {
      // Test-only bootstrap sets a SQLite database page size before the provider schema exists.
      SQLiteDatabase db = SQLiteDatabase.openOrCreateDatabase(context.getDatabasePath("RKStorage"), null);
      db.execSQL("PRAGMA page_size=" + page);
      db.execSQL("CREATE TABLE catalystLocalStorage (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.setVersion(1); db.close();
      return true;
    });
    String mode = args.getString("mode", "default");
    queue(() -> {
      SQLiteDatabase db = ReactDatabaseSupplier.getInstance(context).get();
      result.put("defaultJournalMode", scalar(db,"PRAGMA journal_mode"));
      result.put("defaultSecureDelete", scalar(db,"PRAGMA secure_delete"));
      result.put("synchronous",scalar(db,"PRAGMA synchronous"));
      result.put("journalSizeLimit",scalar(db,"PRAGMA journal_size_limit"));
      result.put("tempStore",scalar(db,"PRAGMA temp_store"));
      result.put("sqliteSourceId",scalar(db,"SELECT sqlite_source_id()"));
      if (!mode.equals("default")) {
        check(java.util.Arrays.asList("delete","truncate","persist","wal").contains(mode), "invalid-test-mode");
        if (mode.equals("wal")) check(db.enableWriteAheadLogging(), "wal-unavailable");
        else check(scalar(db,"PRAGMA journal_mode="+mode).equals(mode), "mode-not-set");
      }
      scalar(db,"PRAGMA secure_delete=OFF");
      scalar(db,"PRAGMA wal_autocheckpoint=0");
      result.put("seedJournalMode", scalar(db,"PRAGMA journal_mode"));
      result.put("sqlitePageSize", scalar(db,"PRAGMA page_size"));
      result.put("vulnerableControlSecureDelete", scalar(db,"PRAGMA secure_delete"));
      return true;
    });
    for (var entry : live.entrySet()) put(entry.getKey(), entry.getValue());
    // Pinned Android provider truncates an embedded NUL on input. Model an
    // already-live SQLite value directly, then assert its exact bytes survive.
    queue(() -> {ReactDatabaseSupplier.getInstance(context).get().execSQL(
        "UPDATE catalystLocalStorage SET value=CAST(X'610062' AS TEXT) WHERE key='library-nul'");return true;});
    result.put("nulFixtureUsesSql", true);
    String[] names = {"plain","passwordOperation","constructorPassword","whole"};
    for (int i=0;i<12;i++) {
      String name = i == 11 ? args.getString("fixture", names[i % names.length]) : names[i % names.length];
      check(java.util.Arrays.asList(names).contains(name), "invalid-fixture");
      String raw = fixture(name);
      // Preserve the archived serializer's escaping; append only public padding.
      put("persist:root", raw.substring(0,raw.length()-1) + ",\"test-public-padding\":\"" +
          repeatText("x",300000 + i*1301) + "\"}");
    }
    CompletableFuture<Void> done = new CompletableFuture<>();
    WritableArray keys = Arguments.createArray(); keys.pushString("persist:root");
    provider.multiRemove(keys, values -> {if(values.length>0 && values[0]!=null) done.completeExceptionally(new AssertionError("provider-remove-failed")); else done.complete(null);});
    done.get(30,TimeUnit.SECONDS);
    exact();
  }
  private void put(String key, String value) throws Exception {
    putAsync(key,value).get(30,TimeUnit.SECONDS);
  }
  private CompletableFuture<Void> putAsync(String key, String value) {
    CompletableFuture<Void> done = new CompletableFuture<>();
    WritableArray pair = Arguments.createArray(); pair.pushString(key); pair.pushString(value);
    WritableArray pairs = Arguments.createArray(); pairs.pushArray(pair);
    provider.multiSet(pairs, values -> {if(values.length>0 && values[0]!=null) done.completeExceptionally(new AssertionError("provider-set-failed")); else done.complete(null);});
    return done;
  }
  private String get(String key) throws Exception {
    return queue(() -> {
      SQLiteDatabase db = ReactDatabaseSupplier.getInstance(context).get();
      long length;
      try (Cursor c = db.rawQuery("SELECT length(CAST(value AS BLOB)) FROM catalystLocalStorage WHERE key=?",new String[]{key})) {
        if (!c.moveToFirst()) return null;
        length = c.getLong(0);
      }
      java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
      for (long offset=0;offset<length;offset+=65536) {
        try (Cursor c = db.rawQuery("SELECT substr(CAST(value AS BLOB),?,65536) FROM catalystLocalStorage WHERE key=?",
            new String[]{Long.toString(offset+1),key})) {
          check(c.moveToFirst(),"missing-live-row");out.write(c.getBlob(0));
        }
      }
      return out.toString(StandardCharsets.UTF_8.name());
    });
  }
  private Map<String,String> snapshot() throws Exception {
    java.util.List<String> keys = queue(() -> {
      java.util.List<String> all = new java.util.ArrayList<>();
      try (Cursor c = ReactDatabaseSupplier.getInstance(context).get().rawQuery("SELECT key FROM catalystLocalStorage ORDER BY key COLLATE BINARY", null)) {
        while(c.moveToNext()) all.add(c.getString(0));
      }
      return all;
    });
    Map<String,String> data = new LinkedHashMap<>();
    for (String key : keys) data.put(key,get(key));
    return data;
  }
  private void exact() throws Exception {
    int index = 0;
    for (var entry : live.entrySet()) {
      String value = get(entry.getKey());
      check(entry.getValue().equals(value), "unrelated-value-changed-at-fixture-" + index + "-expected-length-" + entry.getValue().length() + "-actual-length-" + (value == null ? -1 : value.length()));
      index++;
    }
  }
  private void normalAccess() throws Exception {put("library-after", "normal write after cleanup");check(get("library-after").equals("normal write after cleanup"), "ordinary-access-failed");}
  private String bridge(String method) throws Exception { return bridgeAsync(method).get(60,TimeUnit.SECONDS); }
  private CompletableFuture<String> bridgeAsync(String method) {
    CompletableFuture<String> done = new CompletableFuture<>();
    PromiseImpl promise = new PromiseImpl(values -> done.complete((String) values[0]), values -> done.completeExceptionally(new AssertionError("bridge-rejected")));
    RKStorageModule module = new RKStorageModule(react);
    if(method.equals("inspect")) module.inspect(promise); else module.clean(promise);
    return done;
  }
  private void metadata() throws Exception {
    JSONObject files = new JSONObject();
    for(String suffix : new String[]{"","-wal","-journal","-shm"}) {
      File file=context.getDatabasePath("RKStorage"+suffix);
      files.put(suffix.isEmpty()?"main":suffix.substring(1),file.exists()?file.length():-1);
    }
    result.put("successBoundaryFiles",files);
  }
  private static <T> T queue(Callable<T> work) throws Exception {
    CompletableFuture<T> done=new CompletableFuture<>();
    ReactDatabaseSupplier.DATABASE_EXECUTOR.execute(() -> {try{done.complete(work.call());}catch(Throwable failure){done.completeExceptionally(failure);}});
    return done.get(60,TimeUnit.SECONDS);
  }
  private static String scalar(SQLiteDatabase db,String sql) {try(Cursor c=db.rawQuery(sql,null)){check(c.moveToFirst(),"no-sql-result");return c.getString(0);}}
  private static String repeatText(String value, int count) {
    StringBuilder builder = new StringBuilder(value.length()*count);
    for(int i=0;i<count;i++) builder.append(value);
    return builder.toString();
  }
  private static byte[] readBytes(java.io.InputStream input) throws Exception {
    java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
    byte[] buffer = new byte[8192];int length;
    while((length=input.read(buffer))!=-1) output.write(buffer,0,length);
    return output.toByteArray();
  }
  private static void check(boolean value,String label) {if(!value) throw new AssertionError(label);}
}
