package com.kenbak.lustre

import android.os.Build
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule

/** Exposes the app's version name and code for Settings > About. */
class LustreAppInfoModule(
    private val context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context) {
    override fun getName() = "LustreAppInfo"

    override fun getConstants(): Map<String, Any> {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        val build = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
        return mapOf("version" to (info.versionName ?: ""), "build" to build.toString())
    }
}
