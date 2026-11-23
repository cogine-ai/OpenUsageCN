//! Legacy macOS Keychain item lookup and ACL inspection.
use std::ffi::{c_char, c_void};
use std::ptr::null;
type Ref = *const c_void;
#[repr(C)]
struct Attribute {
    tag: u32,
    length: u32,
    data: *mut c_void,
}
#[repr(C)]
struct Attributes {
    count: u32,
    attributes: *mut Attribute,
}
#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    fn SecKeychainSearchCreateFromAttributes(
        keychain: Ref,
        class: u32,
        attrs: *const Attributes,
        search: *mut Ref,
    ) -> i32;
    fn SecKeychainSearchCopyNext(search: Ref, item: *mut Ref) -> i32;
    fn SecKeychainItemCopyAccess(item: Ref, access: *mut Ref) -> i32;
    fn SecKeychainItemCopyKeychain(item: Ref, keychain: *mut Ref) -> i32;
    fn SecKeychainGetStatus(keychain: Ref, status: *mut u32) -> i32;
    fn SecAccessCopyMatchingACLList(access: Ref, authorization: Ref) -> Ref;
    // SecACL.h defines this selector as uint16; only the older SimpleContents uses a CSSM struct.
    fn SecACLCopyContents(
        acl: Ref,
        applications: *mut Ref,
        description: *mut Ref,
        selector: *mut u16,
    ) -> i32;
    fn SecTrustedApplicationValidateWithPath(application: Ref, path: *const c_char) -> i32;
    fn SecKeychainGetUserInteractionAllowed(allowed: *mut u8) -> i32;
    fn SecKeychainSetUserInteractionAllowed(allowed: u8) -> i32;
    fn SecKeychainItemCopyContent(
        item: Ref,
        class: *mut u32,
        attributes: *mut Attributes,
        length: *mut u32,
        data: *mut *mut u8,
    ) -> i32;
    fn SecKeychainItemFreeContent(attributes: *mut Attributes, data: *mut u8) -> i32;
    static kSecACLAuthorizationDecrypt: Ref;
    static kSecACLAuthorizationEncrypt: Ref;
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(value: Ref);
    fn CFArrayGetCount(array: Ref) -> isize;
    fn CFArrayGetValueAtIndex(array: Ref, index: isize) -> Ref;
}
struct Owned(Ref);
impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) }
        }
    }
}
fn status(code: i32) -> Result<(), String> {
    match code {
        0 => Ok(()),
        -25300 => Err("missing: Keychain item was not found.".into()),
        -25308 | -25291 => Err("locked: Unlock your login Keychain and retry.".into()),
        -25293 | -128 => Err("denied: Keychain access requires authorization.".into()),
        _ => Err("failed: Keychain metadata could not be inspected.".into()),
    }
}
fn find_item(service: &str, account: Option<&str>) -> Result<Owned, String> {
    unsafe {
        let mut attrs = vec![Attribute {
            tag: u32::from_be_bytes(*b"svce"),
            length: service.len() as u32,
            data: service.as_ptr() as *mut c_void,
        }];
        if let Some(account) = account {
            attrs.push(Attribute {
                tag: u32::from_be_bytes(*b"acct"),
                length: account.len() as u32,
                data: account.as_ptr() as *mut c_void,
            });
        }
        let list = Attributes {
            count: attrs.len() as u32,
            attributes: attrs.as_mut_ptr(),
        };
        let mut search = null();
        status(SecKeychainSearchCreateFromAttributes(
            null(),
            u32::from_be_bytes(*b"genp"),
            &list,
            &mut search,
        ))?;
        let search = Owned(search);
        let mut item = null();
        status(SecKeychainSearchCopyNext(search.0, &mut item))?;
        Ok(Owned(item))
    }
}

/// Validate the stored signing requirement for the legacy subprocess without reading the item.
pub(super) fn check(service: &str, account: Option<&str>, writing: bool) -> Result<(), String> {
    let item = find_item(service, account)?;
    unsafe {
        let mut keychain = null();
        status(SecKeychainItemCopyKeychain(item.0, &mut keychain))?;
        let keychain = Owned(keychain);
        let mut flags = 0;
        status(SecKeychainGetStatus(keychain.0, &mut flags))?;
        if flags & 1 == 0 {
            return Err("locked: Unlock your login Keychain and retry.".into());
        }
        let mut access = null();
        status(SecKeychainItemCopyAccess(item.0, &mut access))?;
        let access = Owned(access);
        let mut authorizations = vec![kSecACLAuthorizationDecrypt];
        if writing {
            authorizations.push(kSecACLAuthorizationEncrypt);
        }
        for authorization in authorizations {
            let acls = Owned(SecAccessCopyMatchingACLList(access.0, authorization));
            if acls.0.is_null() {
                return Err("failed: Keychain ACL could not be inspected.".into());
            }
            let mut allowed = false;
            for index in 0..CFArrayGetCount(acls.0) {
                let mut applications = null();
                let mut description = null();
                let mut selector = 0;
                status(SecACLCopyContents(
                    CFArrayGetValueAtIndex(acls.0, index),
                    &mut applications,
                    &mut description,
                    &mut selector,
                ))?;
                let applications = Owned(applications);
                let _description = Owned(description);
                if selector != 0 {
                    continue;
                }
                if applications.0.is_null() {
                    allowed = true;
                    break;
                }
                for index in 0..CFArrayGetCount(applications.0) {
                    if SecTrustedApplicationValidateWithPath(
                        CFArrayGetValueAtIndex(applications.0, index),
                        c"/usr/bin/security".as_ptr(),
                    ) == 0
                    {
                        allowed = true;
                        break;
                    }
                }
                if allowed {
                    break;
                }
            }
            if !allowed {
                return Err("denied: Allow /usr/bin/security to access this item in Keychain Access, then retry.".into());
            }
        }
        Ok(())
    }
}

/// Read with this application's signing identity. Only the explicit desktop action allows UI.
pub(super) fn read_for_app(
    service: &str,
    account: &str,
    interactive: bool,
) -> Result<String, String> {
    use std::{ptr::null_mut, sync::Mutex};

    // The legacy file-based Keychain's interaction switch is process-wide.
    static ACCESS: Mutex<()> = Mutex::new(());
    let _access = ACCESS
        .try_lock()
        .map_err(|_| "busy: Keychain access is in progress.")?;
    let item = find_item(service, Some(account))?;
    unsafe {
        let mut previous = 0;
        status(SecKeychainGetUserInteractionAllowed(&mut previous))?;
        let allowed = u8::from(interactive);
        if previous != allowed {
            status(SecKeychainSetUserInteractionAllowed(allowed))?;
        }
        let mut length = 0;
        let mut data = null_mut();
        let result =
            SecKeychainItemCopyContent(item.0, null_mut(), null_mut(), &mut length, &mut data);
        if previous != allowed && SecKeychainSetUserInteractionAllowed(previous) != 0 {
            log::error!("Cursor Keychain interaction setting could not be restored");
        }
        let password = if result == 0 && !data.is_null() && length > 0 {
            let bytes = std::slice::from_raw_parts_mut(data, length as usize);
            let password = std::str::from_utf8(bytes)
                .map(|value| value.to_owned())
                .ok();
            bytes.fill(0);
            password
        } else {
            None
        };
        if !data.is_null() {
            SecKeychainItemFreeContent(null_mut(), data);
        }
        if result == -25308 && !interactive {
            return Err("denied: Cursor Keychain access requires user interaction.".into());
        }
        status(result)?;
        password.ok_or_else(|| "failed: Cursor Safe Storage item is invalid.".into())
    }
}
