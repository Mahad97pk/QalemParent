//! # Tauri Commands
//!
//! This module re-exports all Tauri command handlers organized by category.

pub mod accounts;
pub mod assets;
pub mod claude;
pub mod clipboard;
pub mod code;
pub mod custom_classes;
pub mod edit;
pub mod edit_css;
pub mod env;
pub mod external_projects;
pub mod folders;
pub mod github;
pub mod health;
pub mod i18n;
pub mod ide;
pub mod monorepo;
pub mod project_meta;
pub mod projects;
pub mod proxy;
pub mod pty;
pub mod settings;
pub mod setup;
pub mod static_server;
pub mod support;
pub mod templates;
pub mod window;

// Re-export all commands for easy access in lib.rs
pub use accounts::*;
pub use assets::*;
pub use claude::*;
pub use clipboard::*;
pub use code::*;
pub use custom_classes::*;
pub use edit::*;
pub use env::*;
pub use external_projects::*;
pub use folders::*;
pub use github::*;
pub use health::*;
pub use i18n::*;
pub use ide::*;
pub use monorepo::*;
pub use projects::*;
pub use proxy::*;
pub use pty::*;
pub use settings::*;
pub use setup::*;
pub use static_server::*;
pub use support::*;
pub use templates::*;
pub use window::*;
