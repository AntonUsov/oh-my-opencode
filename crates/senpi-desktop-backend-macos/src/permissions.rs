//! Actionable TCC refusals. Probes never call this module; denied actions do.

use std::sync::OnceLock;

use senpi_desktop_core::error::{DesktopError, PermissionDeniedData, TccPermission};

#[path = "permissions/request.rs"]
mod request;

const LAUNCHER: &str = "the app that launched OmO (for a terminal launch, that terminal app)";

fn settings_url(permission: TccPermission) -> &'static str {
    match permission {
        TccPermission::ScreenRecording => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        }
        TccPermission::Accessibility => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        }
    }
}

fn host_app_name() -> String {
    launcher_name(std::env::var("SENPI_DESKTOP_HOST_APP").ok())
}

fn launcher_name(value: Option<String>) -> String {
    value.filter(|app| !app.trim().is_empty()).unwrap_or_else(|| LAUNCHER.to_owned())
}

#[derive(Default)]
struct Settings {
    screen_recording: OnceLock<bool>,
    accessibility: OnceLock<bool>,
}

impl Settings {
    fn require_permission(
        &self,
        permission: TccPermission,
        granted: bool,
        requester: impl FnOnce() -> bool,
        opener: impl FnOnce(&str) -> bool,
    ) -> Result<(), DesktopError> {
        if granted {
            return Ok(());
        }
        let (opened, requested_now) = self.open_settings_once(permission, requester, opener);
        Err(denial(permission, host_app_name(), opened, requested_now))
    }

    fn open_settings_once(
        &self,
        permission: TccPermission,
        requester: impl FnOnce() -> bool,
        opener: impl FnOnce(&str) -> bool,
    ) -> (bool, bool) {
        let opened = match permission {
            TccPermission::ScreenRecording => &self.screen_recording,
            TccPermission::Accessibility => &self.accessibility,
        };
        let mut requested_now = false;
        let opened = *opened.get_or_init(|| {
            requested_now = true;
            // The request registers the responsible app even if access remains denied.
            requester();
            opener(settings_url(permission))
        });
        (opened, requested_now)
    }
}

static SETTINGS: Settings = Settings {
    screen_recording: OnceLock::new(),
    accessibility: OnceLock::new(),
};

#[cfg(not(test))]
fn open_settings(url: &str) -> bool {
    match std::process::Command::new("/usr/bin/open").arg(url).status() {
        Ok(status) => status.success(),
        Err(error) => {
            eprintln!("cannot open macOS privacy settings: {error}");
            false
        }
    }
}

// Unit tests simulate denied capture without touching the test runner's desktop.
#[cfg(test)]
fn open_settings(_: &str) -> bool {
    true
}

pub(crate) fn permission_denied(permission: TccPermission) -> DesktopError {
    let (opened, requested_now) =
        SETTINGS.open_settings_once(permission, || request::access(permission), open_settings);
    denial(permission, host_app_name(), opened, requested_now)
}

pub(crate) fn require_permission(permission: TccPermission, granted: bool) -> Result<(), DesktopError> {
    SETTINGS.require_permission(permission, granted, || request::access(permission), open_settings)
}

fn denial(permission: TccPermission, app: String, opened: bool, requested_now: bool) -> DesktopError {
    denial_with_identity(permission, app, opened, requested_now, crate::responsible::current)
}

fn denial_with_identity(
    permission: TccPermission,
    app: String,
    opened: bool,
    requested_now: bool,
    lookup: impl FnOnce() -> Option<crate::responsible::ResponsibleProcess>,
) -> DesktopError {
    let pane = match permission {
        TccPermission::ScreenRecording => "Screen Recording",
        TccPermission::Accessibility => "Accessibility",
    };
    let url = settings_url(permission);
    let identity = crate::responsible::suffix_with(lookup);
    let request = if requested_now {
        format!("Access has been requested so macOS can list {app}. ")
    } else {
        String::new()
    };
    let opening = match (requested_now, opened) {
        (true, true) => format!("System Settings > Privacy & Security > {pane} has been opened"),
        (true, false) => format!(
            "System Settings > Privacy & Security > {pane} could not be opened automatically; open it"
        ),
        (false, true) => format!(
            "In System Settings > Privacy & Security > {pane}, opened earlier"
        ),
        (false, false) => format!("Open System Settings > Privacy & Security > {pane}"),
    };
    let message = format!(
        "macOS {pane} is not granted for {app}. {request}{opening} ({url}): turn on \"{app}\", \
         then fully quit and relaunch {app} before retrying. \
         (TCC identity: {identity})"
    );
    DesktopError::permission_denied_with(
        PermissionDeniedData {
            permission,
            settings_url: url.to_owned(),
            app,
            relaunch_required: true,
        },
        message,
    )
}

#[cfg(test)]
#[path = "permissions/identity_tests.rs"]
mod identity_tests;

#[cfg(test)]
#[path = "permissions/request_tests.rs"]
mod request_tests;

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use super::*;

    #[test]
    fn opens_each_permission_once_even_after_repeated_denials() {
        let settings = Settings::default();
        let opened = RefCell::new(Vec::new());
        let opener = |url: &str| { opened.borrow_mut().push(url.to_owned()); true };
        for permission in [TccPermission::ScreenRecording, TccPermission::ScreenRecording,
            TccPermission::Accessibility, TccPermission::Accessibility] {
            assert!(settings.open_settings_once(permission, || false, opener).0);
        }
        assert_eq!(*opened.borrow(), [
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        ]);
    }

    #[test]
    fn failed_open_is_not_retried_and_keeps_its_failure_state() {
        let settings = Settings::default();
        assert_eq!(settings.open_settings_once(TccPermission::Accessibility, || false, |_| false), (false, true));
        assert_eq!(settings.open_settings_once(TccPermission::Accessibility, || panic!("request retry"), |_| panic!("retry")), (false, false));
    }

    #[test]
    fn absent_and_empty_host_names_use_the_launcher_phrase() {
        for value in [None, Some(String::new()), Some("  ".to_owned())] {
            assert_eq!(launcher_name(value), LAUNCHER);
        }
        assert_eq!(launcher_name(Some("QA App".to_owned())), "QA App");
        let error = denial(TccPermission::ScreenRecording, launcher_name(None), true, true);
        assert_eq!(error.permission.unwrap().app, LAUNCHER);
    }

    #[test]
    fn accessibility_error_carries_the_settings_contract() {
        let error = denial(TccPermission::Accessibility, "QA App".to_owned(), true, true);
        let data = error.permission.unwrap();
        assert_eq!(data.permission, TccPermission::Accessibility);
        assert_eq!(data.settings_url,
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
        assert_eq!(data.app, "QA App");
        assert!(data.relaunch_required);
    }
}
