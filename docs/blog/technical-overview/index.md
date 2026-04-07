---
outline: [2, 3]
---

# Building Fresh: A Technical Overview

Fresh is a terminal-based code editor written from scratch in Rust. This post is an empirical overview of the major features and the non-trivial engineering decisions behind them, drawn from 4,374 commits over ~16 months of development.

## By the Numbers

| Metric | Value |
|---|---|
| Total commits | 4,374 |
| Development period | Dec 2024 -- Apr 2026 |
| Rust source | ~391,000 lines across 524 files |
| TypeScript plugin code | ~34,000 lines |
| Crate count | 8 (`fresh-core`, `fresh-editor`, `fresh-gui`, `fresh-languages`, `fresh-parser-js`, `fresh-plugin-runtime`, `fresh-plugin-api-macros`, `fresh-winterm`) |
| Internal design documents | 50+ |
| Releases | 40+ |
| Platforms | Linux, macOS, Windows, FreeBSD |
| Package formats | deb, rpm, Flatpak, AppImage, AUR, Homebrew, npm, winget, Nix, cargo |
| Syntax grammars | 60+ |
| LSP language configs | 40+ |
| UI languages (i18n) | 11 |

---

## 1. Custom Text Buffer Engine (PieceTree)

A from-scratch persistent data structure for text storage, not using any off-the-shelf rope library.

**Large file support without full scan.** Files are lazily loaded -- only chunks around the viewport are materialized. Line numbers show byte offsets until the user explicitly triggers a parallel line index scan. The git history shows dozens of commits iterating on `ChunkTree`, `ByteIterator`, `LineCache`, and `VirtualBuffer` -- including a full rewrite from ternary to binary tree, then to a children-based structure, with extensive property-based tests.

**O(n) bulk edits and undo integrity.** Multi-cursor replace-all was O(n^2), causing hangs on large files ([#564](https://github.com/sinelaw/fresh/issues/564)). This required inventing a `BulkEdit` operation that applies all edits in a single pass with correct marker displacement, and an undo system that saves/restores displaced marker positions atomically -- with property-based shadow model testing to prove correctness.

---

## 2. LSP Client (Multi-Server, Multi-Language)

Full Language Server Protocol implementation supporting multiple concurrent servers per language with feature-based routing.

**Head-of-line blocking and deadlocks.** LSP notifications (`didClose`, `didChange`, `shutdown`) were blocked behind pending request responses, causing the editor to freeze. The fix required rewriting the `LspTask` command loop to separate notifications from requests. Additionally, LSP server-to-client requests during ongoing client requests caused deadlocks, requiring careful async channel design.

**Document synchronization correctness.** Bulk edits (multi-cursor, toggle comment) bypassed LSP `didChange` notifications, causing document corruption on the server side. The fix required threading LSP notifications through the centralized `apply_events` path, with version tracking per-document and proper `didOpen`/`didClose` lifecycle management across server restarts.

---

## 3. Plugin Runtime (QuickJS)

A sandboxed TypeScript plugin system -- initially built on Deno/V8, then fully rewritten to QuickJS.

**V8 reinitialization segfault.** V8 can only be initialized once per process. On macOS, the `.init_array` linker section didn't exist, causing crashes. The migration to QuickJS eliminated this entire class of problems while also shrinking binary size and enabling musl static builds -- but required reimplementing the entire plugin bridge API, IPC protocol, and type generation system.

**Plugin isolation with shared state.** Each plugin runs in its own QuickJS context, but they need to coordinate (e.g., LSP helpers, git blame, vi mode all touch overlays and buffer state). The solution uses a `PluginCommand` message-passing protocol with namespace-scoped overlay handles, preventing cross-plugin corruption while allowing ~16% CPU reduction by eliminating JSON round-trips in hook dispatch.

---

## 4. Integrated Terminal Emulator

Full terminal emulation using `alacritty_terminal` as a library, with PTY management.

**Scrollback architecture.** The initial approach of syncing terminal output to a text buffer caused data races and content flickering. It went through 3 rewrites: direct sync, file-backed buffer, and finally incremental streaming with a PTY log. The file-backed approach created a novel pattern where the terminal's log file *is* the buffer backing -- enabling session persistence of terminal history across editor restarts.

**Input routing between editor and terminal.** When a terminal split is focused, keys need to go to the PTY -- but `Ctrl+P` (command palette), split navigation, and other editor commands must still work. This required a dual-context keybinding system where "terminal mode" has its own keymap, with `F9` toggling full keyboard capture, and automatic mode restoration when switching tabs.

---

## 5. SSH Remote Editing

Edit files on remote machines over SSH, with full file explorer integration.

**Non-blocking filesystem operations.** All filesystem calls (`readdir`, `stat`, `read`, `write`) go over SSH and can take hundreds of milliseconds. Initially these blocked the main event loop, freezing the UI. The fix required making the entire `FileSystem` trait async, with an `AgentChannel` transport layer that supports reconnection -- and the reconnection itself had to run in a background task with UI feedback for disconnected state.

**Recipe-based patched saves.** Saving a 10MB file with a 100-byte edit shouldn't transfer 10MB. The solution computes a minimal diff "recipe" and sends only the changed portions over SSH, reducing transfer from file-size to edit-size. Combined with backpressure on the bounded channel (fixing silent data loss on macOS with large files), this made remote editing viable for real-world use.

---

## 6. Syntax Highlighting Pipeline

Dual-engine system: TextMate grammars (via syntect) for highlighting + tree-sitter for structural features.

**Large file performance with checkpoints.** On files >100KB, re-highlighting from the start on every edit is too slow. The solution uses a marker-based checkpoint system that stores parse state at intervals, then walks forward from the nearest checkpoint. A convergence algorithm detects when the new parse state matches the old cache, enabling partial updates -- but this had bugs where checkpoint offset drift caused highlighting to disappear when revisiting large files, requiring careful byte-offset accounting.

**Pre-compiled grammars for startup time.** Fresh ships 60+ TextMate grammars. Compiling them at startup took 12 seconds. The fix pre-compiles grammars into a binary `packdump` at build time using `build.rs`, cutting startup from ~350ms to ~170ms. But this required careful cache invalidation when grammars change, and handling the interaction between built-in grammars, user-installed language packs, and config-defined custom grammars.

---

## 7. Settings UI (Schema-Driven)

A full graphical settings editor rendered in the terminal, auto-generated from Rust struct schemas.

**Recursive schema rendering.** The config has deeply nested types: `Map<String, Vec<LspServerConfig>>` where each server config has its own fields. The UI needed a recursive dialog stack with entry dialogs, composite controls (TextList, MapInput, ObjectArray), and proper schema resolution including `anyOf`/`oneOf` patterns for nullable objects. This went through 4 rounds of NNGroup-style usability testing with documented bug reproduction and fixes.

**4-level config layer merging.** Config merges user, platform, project, and session layers. Each setting shows which layer it comes from, the UI allows editing specific layer files, and changes must apply immediately to runtime state. The partial merge system required a custom `Merge` trait across all config types, with "inherit/unset" support so project config can explicitly remove a user-level override.

---

## 8. Session Persistence & Hot Exit

Detach/reattach to editor sessions with full state preservation, including unsaved buffers.

**Client/server architecture for session attach.** Sessions use Unix domain sockets (named pipes on Windows) for client-server communication. The client must faithfully reproduce all terminal capabilities (bracketed paste, Kitty keyboard protocol, mouse tracking) of the original session -- which broke repeatedly (CSI u sequences inserted as literal text [#1113](https://github.com/sinelaw/fresh/issues/1113), clipboard not working, escape sequences not parsed).

**Hot exit recovery for large files.** Unsaved buffers are auto-saved to recovery files every 2 seconds. For large files, the initial approach saved the entire file content, which was both slow and could corrupt if the save was interrupted. The solution uses a chunked recovery format with mtime verification, where only changed regions are written -- requiring careful coordination with the PieceTree's lazy loading to avoid materializing the entire file just for recovery.

---

## 9. Rendering Engine

A custom terminal rendering pipeline handling Unicode, ANSI, overlays, virtual lines, and view transforms.

**Unicode width correctness.** CJK characters, emoji, grapheme clusters (Thai text), combining characters -- each has different visual width rules. The rendering pipeline needed dual mappings: per-character and per-visual-column, for correct cursor positioning, mouse click resolution, and line wrapping. This was broken repeatedly by interactions between ANSI escape codes, syntax highlighting spans, and the line wrap Break tokens.

**View transform pipeline.** Git blame, markdown compose mode, and side-by-side diff all inject "virtual content" (blame annotations, rendered markdown, diff headers) that doesn't exist in the buffer. The view transform system maps source bytes to view bytes to screen coordinates, with bidirectional cursor mapping. This went through 5 iterations (flatten, interleave, token-based, layout-aware, per-frame) to handle scrolling, mouse clicks, and cursor visibility correctly across all transform modes.

---

## 10. Cross-Platform Terminal Compatibility

Works on Linux, macOS, Windows, FreeBSD -- across dozens of terminal emulators.

**Windows terminal input.** Windows Terminal's ConPTY layer causes ConHost console mode drift, corrupt mouse sequences under heavy mouse movement, and UTF-16 surrogate pair edge cases. This required a custom `fresh-winterm` crate that bypasses crossterm entirely, doing direct VT input reads with corrupt sequence detection and console mode heartbeat to counteract the drift.

**256-color contrast enforcement.** In tmux without truecolor, themes become illegible because theme RGB colors get snapped to the nearest 256-color entry. Fresh auto-detects color capability and enforces WCAG 3.0:1 minimum contrast ratio, adjusting foreground colors against their actual background -- which required propagating `ColorCapability` through the entire rendering pipeline instead of using global state.

---

## 11. Multi-Cursor Editing

Full multi-cursor support with atomic undo, proper position tracking across edits.

**Position drift during bulk edits.** When multiple cursors edit simultaneously, each edit shifts the byte positions of subsequent cursors. Cursors "with no events" during bulk edits drifted to stale positions. The fix uses saturating arithmetic to prevent overflow with overlapping selections, and a shadow model with property-based random operation testing across 2--3 cursors to prove correctness.

**Marker-based overlay system.** Overlays (diagnostics, search highlights, semantic tokens) are positioned by byte offset -- but multi-cursor edits shift those offsets. The marker list system tracks positions through edits with automatic adjustment, but bulk edits could collide marker IDs between the `marker_list` and margin systems, requiring careful ID allocation and displaced-marker save/restore on undo.

---

## 12. Packaging & Distribution

Ships on 8+ package managers across 4 operating systems.

**Flatpak AppStream metadata.** Getting the Flatpak submission accepted required 8 consecutive releases (0.1.46 through 0.1.52) fixing AppStream metadata -- from `appstream-compose` dependencies to XML declaration corruption to invalid `launchable` tags. Each fix required a full release cycle to validate.

**Embedded plugins for cargo-binstall.** Binary installations via `cargo binstall` don't include the plugins directory. The solution embeds all plugins in the binary as a fallback using `include_bytes!`, extracting them to XDG cache on first run -- but this interacts with the package manager (user-installed plugins must override embedded ones) and language pack loading order.

---

## 13. Internationalization (i18n)

Full i18n with 11 languages, including plugin translation support.

**Plugin translation coordination.** Each plugin has its own `.i18n.json` translation file, and the `editor.t()` API must resolve translations at runtime with `%{variable}` interpolation. Command names are scoped per-plugin with `%`-prefix collision detection, and the keybinding system doesn't account for keyboard layouts -- making this feature permanently experimental.

---

## 14. GUI Mode (Experimental)

GPU-accelerated windowed mode via winit + wgpu, running the same editor core.

**Same core, different frontend.** The entire editor was built around terminal abstractions (cells, ANSI colors, crossterm events). The GUI backend needed to translate winit events to the same `Action` system, render the cell grid via wgpu shaders, and handle Left/Right Alt distinction on macOS -- while sharing zero rendering code with the terminal backend. The `fresh-gui` crate operates through the `FileSystem` trait and `ColorCapability` abstraction that were originally added for remote editing and terminal compatibility.

---

## Why Building a Code Editor Is Hard

The fundamental difficulty is combinatorial interaction. Every feature interacts with every other feature. Line wrapping changes cursor positioning, which changes mouse click handling, which changes multi-cursor behavior, which changes undo/redo semantics, which changes LSP document sync.

The git history shows this clearly -- features implemented cleanly in isolation break repeatedly when combined, requiring dozens of follow-up fixes. The commit messages tell the story:

- *"Fix cursor disappearing on horizontally scrolled long lines"*
- *"Fix line numbers staying in sync when scrolling with wrapped lines"*
- *"Fix embedded language highlighting breaking at large file offsets"*
- *"Fix bulk edit marker displacement"*
- *"Fix double-click backward drag losing initial word selection"*
- *"Fix undo incorrectly clearing modified flag after hot exit recovery"*

Each one a unique interaction between two or more subsystems that couldn't have been predicted upfront. An editor isn't 14 features -- it's 14 factorial interactions.
