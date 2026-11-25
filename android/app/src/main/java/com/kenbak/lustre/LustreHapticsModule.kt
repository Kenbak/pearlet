package com.kenbak.lustre

import android.os.Build
import android.view.HapticFeedbackConstants
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil

class LustreHapticsModule(
    private val context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context) {
    override fun getName() = "LustreHaptics"

    @ReactMethod
    fun trigger(kind: String) {
        UiThreadUtil.runOnUiThread {
            val view = context.currentActivity?.window?.decorView ?: return@runOnUiThread
            val constant = when (kind) {
                "selection" -> HapticFeedbackConstants.CLOCK_TICK
                "medium" -> HapticFeedbackConstants.CONTEXT_CLICK
                "success" -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.CONTEXT_CLICK
                "warning", "error" -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS
                else -> HapticFeedbackConstants.VIRTUAL_KEY
            }
            view.performHapticFeedback(constant)
        }
    }
}
