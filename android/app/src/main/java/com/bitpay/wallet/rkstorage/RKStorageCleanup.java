package com.bitpay.wallet.rkstorage;

import android.app.Application;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteDatabaseLockedException;
import android.database.sqlite.SQLiteDatabaseCorruptException;
import com.reactnativecommunity.asyncstorage.ReactDatabaseSupplier;
import java.io.File;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** One fixed database, one operation. Never accepts SQL, paths, keys or values from JS. */
public final class RKStorageCleanup {
  public enum Result {
    CLEANED, ABSENT, PRESENT, LIVE_SOURCE, BUSY, IO_DEFERRED, UNSUPPORTED,
    CORRUPT, SIDECARS, PRESERVATION_FAILURE, LIFECYCLE_FAILURE
  }
  private static final ScheduledExecutorService DEADLINES = Executors.newSingleThreadScheduledExecutor();
  private static CompletableFuture<Result> attempt;
  private static final int QUEUE_WAIT_MS = 5000;
  private static final int SQL_WAIT_MS = 1000;
  private static final int CHUNK = 64 * 1024;

  private RKStorageCleanup() {}

  public static CompletableFuture<Result> inspect(Context context) {
    return enqueue(() -> inventory(context));
  }

  public static synchronized CompletableFuture<Result> clean(Context context) {
    if (attempt == null) attempt = enqueue(() -> maintain(context, phase -> {}));
    return attempt;
  }

  private static final class Stop extends Exception {
    final Result result;
    Stop(Result result) { this.result = result; }
  }
  private interface Work { Result run(); }
  private static CompletableFuture<Result> enqueue(Work work) {
    CompletableFuture<Result> result = new CompletableFuture<>();
    AtomicBoolean claimed = new AtomicBoolean();
    // Only an unstarted queue item can expire. Running SQL retains ownership until it ends.
    var deadline = DEADLINES.schedule(() -> {
      if (claimed.compareAndSet(false, true)) result.complete(Result.BUSY);
    }, QUEUE_WAIT_MS, TimeUnit.MILLISECONDS);
    ReactDatabaseSupplier.DATABASE_EXECUTOR.execute(() -> {
      if (!claimed.compareAndSet(false, true)) return;
      deadline.cancel(false);
      try { result.complete(work.run()); }
      catch (Exception failure) { result.complete(Result.LIFECYCLE_FAILURE); }
    });
    return result;
  }

  private static Result inventory(Context context) {
    if (com.reactnativecommunity.asyncstorage.BuildConfig.AsyncStorage_useNextStorage ||
        !context.getPackageName().equals(Application.getProcessName())) return Result.UNSUPPORTED;
    try {
      return ReactDatabaseSupplier.validateStorageFiles(context) ? Result.PRESENT : Result.ABSENT;
    } catch (Exception failure) { return Result.UNSUPPORTED; }
  }

  // Package-private observer is only used by instrumentation, never exposed by the bridge.
  interface Phase { void reached(String phase); }
  static Result maintain(Context context, Phase observer) {
    Result inventory = inventory(context);
    if (inventory != Result.PRESENT) return inventory;
    ReactDatabaseSupplier owner = ReactDatabaseSupplier.getInstance(context);
    SQLiteDatabase db;
    try { db = owner.get(); }
    catch (SQLiteDatabaseCorruptException corrupt) { return Result.CORRUPT; }
    catch (Exception failure) { return Result.IO_DEFERRED; }
    try {
      if (!new File(db.getPath()).getCanonicalFile().equals(
          context.getDatabasePath(ReactDatabaseSupplier.DATABASE_NAME).getCanonicalFile())) return Result.UNSUPPORTED;
    } catch (Exception unreadable) { return Result.IO_DEFERRED; }
    if (db.inTransaction()) return Result.BUSY;
    byte[] before = null;
    String mode = null;
    long sync = -1, secure = -1, wait = -1, journalLimit = -1;
    boolean configured = false;
    Result result = Result.IO_DEFERRED;
    try {
      observer.reached("opened");
      mode = scalar(db, "PRAGMA journal_mode");
      if (!Arrays.asList("delete", "truncate", "persist", "wal").contains(mode))
        throw new Stop(Result.UNSUPPORTED);
      if (!"normal".equals(scalar(db, "PRAGMA locking_mode"))) throw new Stop(Result.BUSY);
      sync = number(db, "PRAGMA synchronous");
      if (sync < 1 || sync > 3) throw new Stop(Result.UNSUPPORTED);
      secure = number(db, "PRAGMA secure_delete");
      wait = number(db, "PRAGMA busy_timeout");
      journalLimit = number(db, "PRAGMA journal_size_limit");
      configured = true;
      if (number(db, "PRAGMA busy_timeout=" + SQL_WAIT_MS) != SQL_WAIT_MS) throw new Stop(Result.UNSUPPORTED);
      // SQLite retains a journal even in DELETE mode while the exclusive lock
      // is held. Bound its finalized size through the engine, including old tails.
      if (number(db, "PRAGMA journal_size_limit=0") != 0) throw new Stop(Result.UNSUPPORTED);
      db.execSQL("PRAGMA synchronous=" + Math.max(2, sync));
      // Include checkpoint/mode changes in the preservation comparison, not
      // just VACUUM. The provider queue already excludes all supported writers.
      if (!schema(db)) throw new Stop(Result.UNSUPPORTED);
      integrity(db);
      if (number(db, "SELECT count(*) FROM catalystLocalStorage WHERE key='persist:root'") != 0)
        throw new Stop(Result.LIVE_SOURCE);
      before = digest(db);
      if ("wal".equals(mode)) {
        observer.reached("before-checkpoint");
        checkpoint(db);
        observer.reached("checkpointed");
        // Drain/disable the provider pool before maintenance: one writer connection.
        db.disableWriteAheadLogging();
      }
      if (!"delete".equals(scalar(db, "PRAGMA journal_mode=DELETE"))) throw new Stop(Result.BUSY);
      // Reapply on the primary connection after any WAL-pool reconfiguration.
      if (number(db, "PRAGMA busy_timeout=" + SQL_WAIT_MS) != SQL_WAIT_MS ||
          number(db, "PRAGMA journal_size_limit=0") != 0) throw new Stop(Result.UNSUPPORTED);
      db.execSQL("PRAGMA synchronous=" + Math.max(2, sync));
      if (number(db, "PRAGMA synchronous") < 2) throw new Stop(Result.UNSUPPORTED);
      if (!"exclusive".equals(scalar(db, "PRAGMA locking_mode=EXCLUSIVE"))) throw new Stop(Result.BUSY);
      // Retain the exclusive connection lock after COMMIT, but VACUUM runs outside a transaction.
      db.execSQL("BEGIN EXCLUSIVE");
      db.execSQL("COMMIT");
      observer.reached("locked");
      if (!schema(db)) throw new Stop(Result.UNSUPPORTED);
      integrity(db);
      // Hot-journal/WAL recovery has already happened. Never delete even a reappearing live root.
      if (number(db, "SELECT count(*) FROM catalystLocalStorage WHERE key='persist:root'") != 0)
        throw new Stop(Result.LIVE_SOURCE);
      if (!MessageDigest.isEqual(before, digest(db))) throw new Stop(Result.PRESERVATION_FAILURE);
      if (number(db, "PRAGMA secure_delete=ON") != 1) throw new Stop(Result.UNSUPPORTED);
      // DELETE journaling finalizes any reused rollback-journal tail through SQLite itself.
      observer.reached("before-vacuum");
      db.execSQL("VACUUM");
      observer.reached("vacuumed");
      integrity(db);
      if (!MessageDigest.isEqual(before, digest(db))) throw new Stop(Result.PRESERVATION_FAILURE);
      File main = context.getDatabasePath(ReactDatabaseSupplier.DATABASE_NAME);
      long pages = number(db, "PRAGMA page_count"), pageSize = number(db, "PRAGMA page_size");
      if (pages <= 0 || pageSize <= 0 || Math.multiplyExact(pages, pageSize) != size(main))
        result = Result.SIDECARS;
      else result = Result.CLEANED;
      observer.reached("verified");
    } catch (Stop stop) {
      result = stop.result;
    } catch (SQLiteDatabaseLockedException busy) {
      result = Result.BUSY;
    } catch (Exception failure) {
      result = Result.IO_DEFERRED;
    } finally {
      if (configured) {
        try {
          // No release/close of the owner while an operation is still executing.
          // A failed native VACUUM must roll back through SQLite before this can succeed.
          if (db.inTransaction()) throw new IllegalStateException();
          if (secure >= 0) number(db, "PRAGMA secure_delete=" + secure);
          if (sync >= 0) db.execSQL("PRAGMA synchronous=" + sync);
          if (journalLimit >= -1) number(db, "PRAGMA journal_size_limit=" + journalLimit);
          if (wait >= 0) number(db, "PRAGMA busy_timeout=" + wait);
          if (!"normal".equals(scalar(db, "PRAGMA locking_mode=NORMAL"))) throw new IllegalStateException();
          if (mode != null && Arrays.asList("delete", "truncate", "persist", "wal").contains(mode)) {
            if ("wal".equals(mode)) {
              if (!db.enableWriteAheadLogging()) throw new IllegalStateException();
            } else if (!mode.equals(scalar(db, "PRAGMA journal_mode=" + mode))) {
              throw new IllegalStateException();
            }
          }
          if (before != null) {
            integrity(db);
            if (!MessageDigest.isEqual(before, digest(db))) result = Result.PRESERVATION_FAILURE;
          }
          owner.closeDatabase();
          observer.reached("closed");
          if (result == Result.CLEANED && !sidecarsFinal(context)) result = Result.SIDECARS;
          // Restore normal provider ownership and check the actual ordinary access/recovery path.
          if (!ReactDatabaseSupplier.validateStorageFiles(context)) throw new IllegalStateException();
          SQLiteDatabase reopened = owner.get();
          if (before != null) {
            integrity(reopened);
            if (!MessageDigest.isEqual(before, digest(reopened))) result = Result.PRESERVATION_FAILURE;
          }
          if (result == Result.CLEANED && !sidecarsFinal(context)) result = Result.SIDECARS;
          observer.reached("reopened");
        } catch (Exception unsafeLifecycle) { result = Result.LIFECYCLE_FAILURE; }
      }
    }
    return result;
  }

  private static void checkpoint(SQLiteDatabase db) {
    try (Cursor c = db.rawQuery("PRAGMA wal_checkpoint(TRUNCATE)", null)) {
      if (!c.moveToFirst() || c.getColumnCount() != 3 || c.getInt(0) != 0 ||
          c.getInt(1) != 0 || c.getInt(2) != 0 || c.moveToNext())
        throw new SQLiteDatabaseLockedException("RKSTORAGE_BUSY");
    }
  }

  private static boolean schema(SQLiteDatabase db) {
    if (db.getAttachedDbs().size() != 1) return false;
    if (number(db, "PRAGMA user_version") != 1) return false;
    if (number(db, "SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' " +
        "AND NOT (type='table' AND name IN ('catalystLocalStorage','android_metadata'))") != 0) return false;
    try (Cursor c = db.rawQuery("PRAGMA table_info(catalystLocalStorage)", null)) {
      return c.moveToFirst() && "key".equals(c.getString(1)) && "TEXT".equals(c.getString(2)) &&
          c.getInt(5) == 1 && c.moveToNext() && "value".equals(c.getString(1)) &&
          "TEXT".equals(c.getString(2)) && c.getInt(3) == 1 && c.getInt(5) == 0 && !c.moveToNext();
    }
  }

  private static void integrity(SQLiteDatabase db) {
    if (!"ok".equals(scalar(db, "PRAGMA integrity_check"))) throw new IllegalStateException();
  }

  /** Bounded 64 KiB chunks; framed UTF-8 bytes, not ambiguous concatenation or counts alone. */
  private static byte[] digest(SQLiteDatabase db) throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    long rows = 0;
    try (Cursor c = db.rawQuery("SELECT rowid,typeof(key),typeof(value),length(CAST(key AS BLOB))," +
        "length(CAST(value AS BLOB)) FROM catalystLocalStorage ORDER BY key COLLATE BINARY", null)) {
      while (c.moveToNext()) {
        if (!"text".equals(c.getString(1)) || !"text".equals(c.getString(2))) throw new IllegalStateException();
        rows++;
        for (int column = 0; column < 2; column++) {
          long length = c.getLong(column + 3);
          digest.update(ByteBuffer.allocate(8).putLong(length).array());
          for (long offset = 0; offset < length; offset += CHUNK) {
            try (Cursor part = db.rawQuery("SELECT substr(CAST(" + (column == 0 ? "key" : "value") +
                " AS BLOB),?,?) FROM catalystLocalStorage WHERE rowid=?",
                new String[]{Long.toString(offset + 1), Integer.toString(CHUNK), Long.toString(c.getLong(0))})) {
              if (!part.moveToFirst()) throw new IllegalStateException();
              byte[] bytes = part.getBlob(0);
              if (bytes.length != Math.min(CHUNK, length - offset)) throw new IllegalStateException();
              digest.update(bytes);
            }
          }
        }
      }
    }
    digest.update(ByteBuffer.allocate(8).putLong(rows).array());
    return digest.digest();
  }

  private static String scalar(SQLiteDatabase db, String sql) {
    try (Cursor c = db.rawQuery(sql, null)) {
      if (!c.moveToFirst()) throw new IllegalStateException();
      String value = c.getString(0);
      if (c.moveToNext()) throw new IllegalStateException();
      return value;
    }
  }
  private static long number(SQLiteDatabase db, String sql) { return Long.parseLong(scalar(db, sql)); }
  private static long size(File file) throws Exception {
    try {
      BasicFileAttributes attr = Files.readAttributes(file.toPath(), BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
      if (!attr.isRegularFile() || !Files.isReadable(file.toPath())) throw new IllegalStateException();
      return attr.size();
    } catch (NoSuchFileException absent) { return -1; }
  }
  private static boolean sidecarsFinal(Context context) throws Exception {
    File main = context.getDatabasePath(ReactDatabaseSupplier.DATABASE_NAME);
    if (!ReactDatabaseSupplier.validateStorageFiles(context)) return false;
    for (String suffix : new String[]{"-wal", "-journal"}) if (size(new File(main + suffix)) > 0) return false;
    // SHM contains the WAL index/locks, not payload. Never unlink it; a reopened WAL pool may recreate it.
    size(new File(main + "-shm"));
    return true;
  }
}
