package com.kenbak.lustre

import android.view.WindowManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil

/**
 * Blocks screenshots, screen recording and the recents preview while a
 * recovery phrase is on screen.
 */
class LustreScreenGuardModule(
    private val context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context) {
    override fun getName() = "LustreScreenGuard"

    @ReactMethod
    fun setSecure(secure: Boolean, promise: Promise) {
        UiThreadUtil.runOnUiThread {
            val window = context.currentActivity?.window
            if (window == null) {
                promise.reject("NO_WINDOW", "The screen could not be protected.")
                return@runOnUiThread
            }
            if (secure) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
            promise.resolve(null)
        }
    }

    /** FLAG_SECURE already keeps the window out of captures on Android. */
    @ReactMethod
    fun isCaptured(promise: Promise) {
        promise.resolve(false)
    }
}
