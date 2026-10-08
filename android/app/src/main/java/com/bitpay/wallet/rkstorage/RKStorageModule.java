package com.bitpay.wallet.rkstorage;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

public final class RKStorageModule extends ReactContextBaseJavaModule {
  public RKStorageModule(ReactApplicationContext context) { super(context); }
  @Override public String getName() { return "BitPayRKStorage"; }
  @ReactMethod public void inspect(Promise promise) {
    RKStorageCleanup.inspect(getReactApplicationContext()).thenAccept(result -> promise.resolve(result.name()));
  }
  @ReactMethod public void clean(Promise promise) {
    RKStorageCleanup.clean(getReactApplicationContext()).thenAccept(result -> promise.resolve(result.name()));
  }
}
