//! Inspect metadata and ACLs only. Never request password data during preflight.
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
/// Validate the stored signing requirement against the actual accessor, not just its path.
pub(super) fn check(service: &str, account: Option<&str>, writing: bool) -> Result<(), String> {
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
        let item = Owned(item);
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
