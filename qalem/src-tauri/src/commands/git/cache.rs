//! # Generic TTL Cache
//!
//! A small generic keyed TTL cache used by non-git callers (GitHub username
//! lookups, project type detection, etc.) so they don't have to reimplement
//! the same expiry-check / HashMap / Mutex dance.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Cache entry with value and expiration time
#[derive(Clone)]
struct CacheEntry<T: Clone> {
    value: T,
    expires_at: Instant,
}

impl<T: Clone> CacheEntry<T> {
    fn new(value: T, ttl: Duration) -> Self {
        Self {
            value,
            expires_at: Instant::now() + ttl,
        }
    }

    fn is_expired(&self) -> bool {
        Instant::now() >= self.expires_at
    }
}

/// Generic keyed TTL cache. Extracted during Block 11 of the DX refactor so
/// non-git callers (github username, project type detection, …) don't have to
/// re-implement the same expiry-check / HashMap / Mutex dance.
///
/// Usage:
/// ```ignore
/// static FOO_CACHE: LazyLock<TtlCache<String, String>> =
///     LazyLock::new(|| TtlCache::new(Duration::from_secs(600)));
/// FOO_CACHE.insert("alice".into(), "value".into());
/// if let Some(v) = FOO_CACHE.get("alice") { … }
/// ```
pub struct TtlCache<K: Eq + std::hash::Hash + Clone, V: Clone> {
    inner: Mutex<HashMap<K, CacheEntry<V>>>,
    ttl: Duration,
}

impl<K: Eq + std::hash::Hash + Clone, V: Clone> TtlCache<K, V> {
    pub fn new(ttl: Duration) -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            ttl,
        }
    }

    pub fn get<Q>(&self, key: &Q) -> Option<V>
    where
        K: std::borrow::Borrow<Q>,
        Q: std::hash::Hash + Eq + ?Sized,
    {
        let cache = self.inner.lock().ok()?;
        let entry = cache.get(key)?;
        if entry.is_expired() {
            None
        } else {
            Some(entry.value.clone())
        }
    }

    pub fn insert(&self, key: K, value: V) {
        if let Ok(mut cache) = self.inner.lock() {
            cache.retain(|_, entry| !entry.is_expired());
            cache.insert(key, CacheEntry::new(value, self.ttl));
        }
    }

    pub fn invalidate<Q>(&self, key: &Q)
    where
        K: std::borrow::Borrow<Q>,
        Q: std::hash::Hash + Eq + ?Sized,
    {
        if let Ok(mut cache) = self.inner.lock() {
            cache.remove(key);
        }
    }

    pub fn clear(&self) {
        if let Ok(mut cache) = self.inner.lock() {
            cache.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ============ TtlCache lifecycle ============

    #[test]
    fn ttl_cache_miss_then_hit_then_expire() {
        let cache: TtlCache<String, i32> = TtlCache::new(Duration::from_millis(50));
        assert_eq!(cache.get("k"), None, "initial miss");
        cache.insert("k".to_string(), 42);
        assert_eq!(cache.get("k"), Some(42), "hit while fresh");
        std::thread::sleep(Duration::from_millis(75));
        assert_eq!(cache.get("k"), None, "expired after TTL");
    }

    #[test]
    fn ttl_cache_invalidate_removes_entry() {
        let cache: TtlCache<String, String> = TtlCache::new(Duration::from_secs(60));
        cache.insert("alice".to_string(), "secret".to_string());
        assert_eq!(cache.get("alice"), Some("secret".to_string()));
        cache.invalidate("alice");
        assert_eq!(cache.get("alice"), None, "invalidated key must miss");
    }

    #[test]
    fn ttl_cache_clear_removes_all() {
        let cache: TtlCache<String, u32> = TtlCache::new(Duration::from_secs(60));
        cache.insert("a".to_string(), 1);
        cache.insert("b".to_string(), 2);
        cache.clear();
        assert_eq!(cache.get("a"), None);
        assert_eq!(cache.get("b"), None);
    }

    #[test]
    fn ttl_cache_insert_overwrites_existing() {
        let cache: TtlCache<String, i32> = TtlCache::new(Duration::from_secs(60));
        cache.insert("k".to_string(), 1);
        cache.insert("k".to_string(), 2);
        assert_eq!(cache.get("k"), Some(2), "second insert must overwrite");
    }

    #[test]
    fn cache_entry_is_expired_detects_past_deadline() {
        let entry: CacheEntry<i32> = CacheEntry {
            value: 1,
            expires_at: Instant::now() - Duration::from_secs(1),
        };
        assert!(entry.is_expired());

        let fresh: CacheEntry<i32> = CacheEntry {
            value: 1,
            expires_at: Instant::now() + Duration::from_secs(60),
        };
        assert!(!fresh.is_expired());
    }
}
