//! # GitHub CLI Helpers
//!
//! Small internal helpers for building `gh` CLI commands scoped to the
//! correct workspace account, and for invalidating the cached GitHub
//! username after auth or workspace changes. Used by accounts.rs, support.rs,
//! and setup/status.rs.

use crate::cache::TtlCache;
use crate::utils::{create_command, find_executable, get_extended_path};
use std::process::Command;
use std::sync::LazyLock;
use std::time::Duration;

/// 10-minute TTL cache for `gh api user --jq .login`, keyed by the workspace
/// (account) id the lookup ran under. The username rarely changes during a
/// session; the uncached call adds ~200ms and hits the network, so caching is a
/// meaningful perf win. Keying by account id is essential: the same call
/// resolves to a *different* GitHub identity per workspace, so a single
/// unit-keyed cache would hand one workspace's login to another (the
/// "Create Repo defaulted to the wrong owner" bug).
static GITHUB_USERNAME_CACHE: LazyLock<TtlCache<String, String>> =
    LazyLock::new(|| TtlCache::new(Duration::from_secs(600)));

/// Invalidate every cached GitHub username. Call after auth changes or a
/// workspace switch — both can change which login any account resolves to.
pub fn invalidate_github_username_cache() {
    GITHUB_USERNAME_CACHE.clear();
}

/// Returns a Command for gh with extended PATH set, scoped to the globally
/// active workspace. Use this for gh operations with no project context
/// (e.g. `gh auth status`). For operations that act on a specific project,
/// prefer [`get_gh_command_for_project`] so the project's workspace auth is used.
pub fn get_gh_command() -> Command {
    let mut cmd = if let Some(path) = find_executable("gh") {
        create_command(path)
    } else {
        create_command("gh")
    };
    cmd.env("PATH", get_extended_path());
    cmd.envs(crate::commands::accounts::get_env_vars_for_active_account());
    cmd
}

/// Like [`get_gh_command`], but scoped to the workspace the given project
/// belongs to (falling back to the active workspace when untagged). This is how
/// `gh pr create/list/merge/...` use the *project's* GitHub login rather than
/// whichever workspace is globally active — so a PR opened from a Beta-workspace
/// project authenticates as Beta even while Acme is the active workspace.
pub fn get_gh_command_for_project(project_path: &std::path::Path) -> Command {
    let mut cmd = if let Some(path) = find_executable("gh") {
        create_command(path)
    } else {
        create_command("gh")
    };
    cmd.env("PATH", get_extended_path());
    cmd.envs(crate::commands::accounts::get_env_vars_for_project(
        project_path,
    ));
    cmd
}
