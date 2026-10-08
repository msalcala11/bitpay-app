package com.bitpay.wallet.rkstorage

import android.app.Application
import android.app.Instrumentation
import android.content.Context
import android.os.SystemClock
import com.facebook.react.PackageList
import com.facebook.react.defaults.DefaultReactHost
import java.io.File
import org.json.JSONObject

/** Uses the real bridgeless Hermes host and autolinked production packages. */
object RKStorageReactTest {
    @JvmStatic
    fun run(instrumentation: Instrumentation, operation: String): JSONObject {
        val context = instrumentation.targetContext
        val output = File(context.filesDir, "rkstorage-react-result.json")
        output.delete() // test-only safe aggregate result, never a persistence source
        File(context.filesDir, "rkstorage-react-case.json").writeText(JSONObject().put("operation", operation).toString())
        val bundle = File(context.cacheDir, "rkstorage-test.bundle")
        instrumentation.context.assets.open("rkstorage-test.bundle").use { input ->
            bundle.outputStream().use { input.copyTo(it) }
        }
        val packages = PackageList(context.applicationContext as Application).packages
        packages.add(RKStoragePackage())
        val host = DefaultReactHost.getDefaultReactHost(
            context = context,
            packageList = packages,
            jsBundleFilePath = bundle.absolutePath,
            useDevSupport = false,
            exceptionHandler = { output.writeText("{\"failed\":true,\"nativeHost\":true}") },
        )
        instrumentation.runOnMainSync { host.start() }
        val deadline = SystemClock.elapsedRealtime() + 90000
        while (!output.exists() && SystemClock.elapsedRealtime() < deadline) Thread.sleep(100)
        check(output.exists()) { "react-harness-timeout" }
        val result = JSONObject(output.readText())
        check(!result.optBoolean("failed")) { "react-harness-failed" }
        return result
    }
}
