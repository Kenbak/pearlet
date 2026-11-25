package com.kenbak.lustre

import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.security.SecureRandom

/**
 * Random bytes from the system generator, for wallet seeds and signing.
 * Fails rather than returning anything weaker.
 */
class LustreEntropyModule(
    context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context) {
    private val random = SecureRandom()

    override fun getName() = "LustreEntropy"

    @ReactMethod
    fun randomBase64(byteLength: Double, promise: Promise) {
        if (byteLength < 1 || byteLength > 65536 || byteLength != Math.floor(byteLength)) {
            promise.reject("ENTROPY_INVALID", "Invalid entropy length.")
            return
        }
        try {
            val data = ByteArray(byteLength.toInt())
            random.nextBytes(data)
            val encoded = Base64.encodeToString(data, Base64.NO_WRAP)
            data.fill(0)
            promise.resolve(encoded)
        } catch (error: Exception) {
            promise.reject("ENTROPY_FAILED", "The device could not provide secure randomness.", error)
        }
    }
}
