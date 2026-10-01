use std::cell::RefCell;

use super::*;
use senpi_desktop_core::error::ErrorCode;

const PERMISSIONS: [TccPermission; 2] =
    [TccPermission::ScreenRecording, TccPermission::Accessibility];

#[test]
fn first_denial_requests_before_opening_each_pane() {
    for permission in PERMISSIONS {
        let settings = Settings::default();
        let events = RefCell::new(Vec::new());
        let error = settings.require_permission(
            permission,
            false,
            || { events.borrow_mut().push("request"); false },
            |_| { events.borrow_mut().push("open"); true },
        ).unwrap_err();
        assert_eq!(*events.borrow(), ["request", "open"]);
        assert_eq!(error.code, ErrorCode::PermissionDenied);
    }
}

#[test]
fn repeated_denials_do_not_request_or_open_again() {
    for permission in PERMISSIONS {
        let settings = Settings::default();
        let requests = RefCell::new(0);
        let opens = RefCell::new(0);
        for _ in 0..3 {
            assert!(settings.require_permission(
                permission,
                false,
                || { *requests.borrow_mut() += 1; false },
                |_| { *opens.borrow_mut() += 1; true },
            ).is_err());
        }
        assert_eq!(*requests.borrow(), 1);
        assert_eq!(*opens.borrow(), 1);
    }
}

#[test]
fn granted_access_neither_requests_nor_opens_and_does_not_consume_latch() {
    for permission in PERMISSIONS {
        let settings = Settings::default();
        settings.require_permission(
            permission, true, || panic!("granted request"), |_| panic!("granted pane"),
        ).unwrap();
        let requests = RefCell::new(0);
        assert!(settings.require_permission(
            permission, false, || { *requests.borrow_mut() += 1; false }, |_| true,
        ).is_err());
        assert_eq!(*requests.borrow(), 1);
    }
}

#[test]
fn unsuccessful_request_and_pane_still_return_actionable_permission_data() {
    for permission in PERMISSIONS {
        let settings = Settings::default();
        let requests = RefCell::new(0);
        let error = settings.require_permission(
            permission, false, || { *requests.borrow_mut() += 1; false }, |_| false,
        ).unwrap_err();
        assert_eq!(*requests.borrow(), 1);
        assert_eq!(error.code, ErrorCode::PermissionDenied);
        let data = error.permission.unwrap();
        assert_eq!(data.permission, permission);
        assert!(data.relaunch_required);
        assert!(!data.app.is_empty());
        assert!(!data.settings_url.is_empty());
        assert!(settings.require_permission(
            permission, false, || panic!("request retry"), |_| panic!("pane retry"),
        ).is_err());
    }
}

#[test]
fn successful_request_still_returns_guidance_for_relaunch() {
    for permission in PERMISSIONS {
        let settings = Settings::default();
        let requests = RefCell::new(0);
        let error = settings.require_permission(
            permission, false, || { *requests.borrow_mut() += 1; true }, |_| true,
        ).unwrap_err();
        assert_eq!(*requests.borrow(), 1);
        assert!(error.permission.unwrap().relaunch_required);
    }
}

#[test]
fn repeat_guidance_describes_the_pane_opened_earlier_not_a_new_request() {
    for permission in PERMISSIONS {
        let settings = Settings::default();
        let first = settings.require_permission(permission, false, || false, |_| true).unwrap_err();
        let repeated = settings.require_permission(
            permission, false, || panic!("repeat request"), |_| panic!("repeat open"),
        ).unwrap_err();
        assert!(first.message.contains("Access has been requested"));
        assert!(first.message.contains("has been opened"));
        assert!(repeated.message.contains("opened earlier"));
        assert!(!repeated.message.contains("Access has been requested"));
        assert!(!repeated.message.contains("has been opened"));
        assert!(repeated.permission.unwrap().relaunch_required);
    }
}

#[test]
fn repeat_guidance_does_not_claim_a_failed_pane_was_opened() {
    for permission in PERMISSIONS {
        let settings = Settings::default();
        let first = settings.require_permission(permission, false, || false, |_| false).unwrap_err();
        let repeated = settings.require_permission(
            permission, false, || panic!("repeat request"), |_| panic!("repeat open"),
        ).unwrap_err();
        assert!(first.message.contains("Access has been requested"));
        assert!(first.message.contains("could not be opened"));
        assert!(!repeated.message.contains("opened earlier"));
        assert!(!repeated.message.contains("Access has been requested"));
        assert!(repeated.message.contains("Open System Settings"));
        assert!(repeated.permission.unwrap().relaunch_required);
    }
}
