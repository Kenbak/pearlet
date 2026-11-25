package com.kenbak.lustre

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Copies a secret marked as sensitive (hidden from clipboard previews on
 * Android 13+) and clears it after a timeout if it is still on the clipboard.
 */
class LustreSecureClipboardModule(
    private val context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context) {
    private val handler = Handler(Looper.getMainLooper())

    override fun getName() = "LustreSecureClipboard"

    @ReactMethod
    fun copySensitive(text: String, seconds: Double, promise: Promise) {
        if (text.isEmpty() || seconds <= 0) {
            promise.reject("COPY_INVALID", "Nothing to copy.")
            return
        }
        handler.post {
            try {
                val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                val clip = ClipData.newPlainText("Pearlet", text)
                clip.description.extras = PersistableBundle().apply {
                    if (Build.VERSION.SDK_INT >= 33) {
                        putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
                    } else {
                        putBoolean("android.content.extra.IS_SENSITIVE", true)
                    }
                }
                clipboard.setPrimaryClip(clip)
                handler.postDelayed({ clearIfUnchanged(clipboard, text) }, (seconds * 1000).toLong())
                promise.resolve(null)
            } catch (error: Exception) {
                promise.reject("COPY_FAILED", "Could not copy to the clipboard.", error)
            }
        }
    }

    /** An ordinary copy, for public values such as addresses. */
    @ReactMethod
    fun setString(text: String, promise: Promise) {
        handler.post {
            try {
                val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                clipboard.setPrimaryClip(ClipData.newPlainText("Pearlet", text))
                promise.resolve(null)
            } catch (error: Exception) {
                promise.reject("COPY_FAILED", "Could not copy to the clipboard.", error)
            }
        }
    }

    @ReactMethod
    fun getString(promise: Promise) {
        handler.post {
            try {
                val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                val item = clipboard.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)
                promise.resolve(item?.coerceToText(context)?.toString() ?: "")
            } catch (error: Exception) {
                promise.reject("PASTE_FAILED", "Could not read the clipboard.", error)
            }
        }
    }

    private fun clearIfUnchanged(clipboard: ClipboardManager, text: String) {
        try {
            val current = clipboard.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text?.toString()
            if (current != text) return
            if (Build.VERSION.SDK_INT >= 28) clipboard.clearPrimaryClip()
            else clipboard.setPrimaryClip(ClipData.newPlainText("", ""))
        } catch (_: Exception) {
            // The clipboard may be unavailable while the app is in the background.
        }
    }
}
