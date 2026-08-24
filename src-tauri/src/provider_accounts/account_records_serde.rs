use super::state::AccountRecord;
use serde::de::Error as _;
use serde::ser::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::BTreeMap;

pub(super) fn serialize<S>(records: &[AccountRecord], serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    let mut keyed = BTreeMap::new();
    for record in records {
        if record.account_id.is_empty() || keyed.insert(record.account_id.clone(), record).is_some()
        {
            return Err(S::Error::custom("provider account IDs must be unique"));
        }
    }
    keyed.serialize(serializer)
}

pub(super) fn deserialize<'de, D>(deserializer: D) -> Result<Vec<AccountRecord>, D::Error>
where
    D: Deserializer<'de>,
{
    let keyed = BTreeMap::<String, AccountRecord>::deserialize(deserializer)?;
    let mut records = Vec::with_capacity(keyed.len());
    for (account_id, record) in keyed {
        if account_id.is_empty() || record.account_id != account_id {
            return Err(D::Error::custom(
                "provider account key does not match accountId",
            ));
        }
        records.push(record);
    }
    Ok(records)
}
