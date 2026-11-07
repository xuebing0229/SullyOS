package __APP_ID__.plugins

import android.view.View
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.lifecycle.setViewTreeViewModelStoreOwner
import androidx.savedstate.SavedStateRegistry
import androidx.savedstate.SavedStateRegistryController
import androidx.savedstate.SavedStateRegistryOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner

// Copied from FloatingX 3 FxComposeOwner.kt (MIT).
// Package/name only adapted for SullyOS.
// Source:
// floatingx-compose/src/main/kotlin/com/petterp/floatingx/compose/FxComposeOwner.kt
class SullyFloatingComposeOwner : LifecycleOwner, ViewModelStoreOwner, SavedStateRegistryOwner {

    private val registry = LifecycleRegistry(this)
    private val savedStateController = SavedStateRegistryController.create(this)
    private val store = ViewModelStore()

    override val lifecycle: Lifecycle get() = registry
    override val viewModelStore: ViewModelStore get() = store
    override val savedStateRegistry: SavedStateRegistry get() = savedStateController.savedStateRegistry

    val isDestroyed: Boolean get() = registry.currentState == Lifecycle.State.DESTROYED

    init {
        savedStateController.performAttach()
        savedStateController.performRestore(null)
        registry.currentState = Lifecycle.State.CREATED
    }

    fun moveTo(state: Lifecycle.State) {
        if (isDestroyed) return
        require(state != Lifecycle.State.DESTROYED && state != Lifecycle.State.INITIALIZED) {
            "请用 destroy()；不支持 $state"
        }
        registry.currentState = state
    }

    fun destroy() {
        if (isDestroyed) return
        registry.currentState = Lifecycle.State.DESTROYED
        store.clear()
    }

    fun attachTo(view: View) {
        view.setViewTreeLifecycleOwner(this)
        view.setViewTreeViewModelStoreOwner(this)
        view.setViewTreeSavedStateRegistryOwner(this)
    }

    companion object {
        @JvmStatic
        fun detachFrom(view: View) {
            view.setViewTreeLifecycleOwner(null)
            view.setViewTreeViewModelStoreOwner(null)
            view.setViewTreeSavedStateRegistryOwner(null)
        }
    }
}
