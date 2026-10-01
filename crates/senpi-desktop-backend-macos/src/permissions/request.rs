//! Native TCC requests, called only by the once-per-permission denial latch.

use senpi_desktop_core::error::TccPermission;

#[cfg(not(test))]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    safe fn CGRequestScreenCaptureAccess() -> bool;
}

#[cfg(not(test))]
pub(super) fn access(permission: TccPermission) -> bool {
    match permission {
        TccPermission::ScreenRecording => {
            crate::capture::capture_permission() || CGRequestScreenCaptureAccess()
        }
        TccPermission::Accessibility => {
            if crate::ax::is_trusted() {
                return true;
            }
            use objc2_application_services::{
                kAXTrustedCheckOptionPrompt, AXIsProcessTrustedWithOptions,
            };
            use objc2_core_foundation::{CFBoolean, CFDictionary};

            // SAFETY: The framework key is a process-lifetime CFString.
            let key = unsafe { kAXTrustedCheckOptionPrompt };
            let options = CFDictionary::from_slices(&[key], &[CFBoolean::new(true)]);
            // SAFETY: The retained dictionary holds the documented CFString key
            // and CFBoolean value and outlives the synchronous framework call.
            unsafe { AXIsProcessTrustedWithOptions(Some(options.as_opaque())) }
        }
    }
}

// Never request real TCC access from the unit-test process.
#[cfg(test)]
pub(super) fn access(_: TccPermission) -> bool {
    false
}
