package com.kenbak.lustre

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class LustreDeviceAuthModule(
    private val context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context) {
    private companion object {
        const val CREDENTIAL_REQUEST = 6027
    }

    // Accessed only on the activity's UI thread.
    private data class Attempt(
        val promise: Promise,
        var prompt: BiometricPrompt? = null,
        var awaitingCredential: Boolean = false,
    )

    private var active: Attempt? = null
    private val activityListener = object : BaseActivityEventListener() {
        override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
            val attempt = active ?: return
            if (requestCode == CREDENTIAL_REQUEST && attempt.awaitingCredential) {
                finish(attempt, resultCode == Activity.RESULT_OK)
            }
        }
    }

    init {
        context.addActivityEventListener(activityListener)
    }

    override fun getName() = "LustreDeviceAuth"

    @ReactMethod
    fun authenticate(reason: String, promise: Promise) {
        val activity = context.currentActivity as? FragmentActivity
        if (activity == null) {
            promise.reject("AUTH_UNAVAILABLE", "Open Pearlet to authenticate.")
            return
        }

        activity.runOnUiThread {
            if (activity.isFinishing || activity.isDestroyed) {
                promise.reject("AUTH_UNAVAILABLE", "Open Pearlet to authenticate.")
                return@runOnUiThread
            }
            if (active != null) {
                promise.reject("AUTH_BUSY", "Device authentication is already in progress.")
                return@runOnUiThread
            }

            val attempt = Attempt(promise)
            active = attempt
            try {
                showPrompt(activity, reason, attempt)
            } catch (error: Exception) {
                finish(attempt, false, "Device authentication is unavailable.", error)
            }
        }
    }

    private fun showPrompt(activity: FragmentActivity, reason: String, attempt: Attempt) {
        val modern = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
        val authenticators = if (modern) BIOMETRIC_STRONG or DEVICE_CREDENTIAL else BIOMETRIC_STRONG
        val supported = BiometricManager.from(activity).canAuthenticate(authenticators)
        if (supported != BiometricManager.BIOMETRIC_SUCCESS) {
            showScreenLock(activity, reason, attempt)
            return
        }
        val prompt = BiometricPrompt(
            activity,
            ContextCompat.getMainExecutor(activity),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    finish(attempt, true)
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    if (active !== attempt || attempt.awaitingCredential) return
                    if (!modern && (
                            errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                                errorCode == BiometricPrompt.ERROR_LOCKOUT ||
                                errorCode == BiometricPrompt.ERROR_LOCKOUT_PERMANENT
                            )) {
                        showScreenLock(activity, reason, attempt)
                    } else {
                        finish(attempt, false)
                    }
                }
            },
        )
        attempt.prompt = prompt
        val options = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Authenticate with your device")
            .setSubtitle(reason)
            .setAllowedAuthenticators(authenticators)
            .setConfirmationRequired(true)
        if (!modern) options.setNegativeButtonText("Use screen lock")
        prompt.authenticate(options.build())
    }

    @Suppress("DEPRECATION")
    private fun showScreenLock(activity: FragmentActivity, reason: String, attempt: Attempt) {
        val keyguard = activity.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
        val intent = if (keyguard?.isDeviceSecure == true) {
            keyguard.createConfirmDeviceCredentialIntent("Authenticate with your device", reason)
        } else {
            null
        }
        if (intent == null) {
            finish(attempt, false, "Set a device screen lock in Settings to use this action.")
            return
        }
        attempt.awaitingCredential = true
        try {
            activity.startActivityForResult(intent, CREDENTIAL_REQUEST)
        } catch (error: Exception) {
            finish(attempt, false, "The device screen lock could not be opened.", error)
        }
    }

    private fun finish(
        attempt: Attempt,
        authenticated: Boolean,
        message: String = "Device authentication did not complete.",
        error: Throwable? = null,
    ) {
        if (active !== attempt) return
        active = null
        if (authenticated) attempt.promise.resolve(null)
        else attempt.promise.reject("AUTH_FAILED", message, error)
    }

    override fun invalidate() {
        context.removeActivityEventListener(activityListener)
        context.runOnUiQueueThread {
            val attempt = active ?: return@runOnUiQueueThread
            finish(attempt, false)
            attempt.prompt?.cancelAuthentication()
        }
        super.invalidate()
    }
}
