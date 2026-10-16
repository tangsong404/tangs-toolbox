---
name: everything-find
description: Fast indexed file/directory search on Windows via es.exe. Trigger on user file/dir find requests, dependency/tool location ("where is python", "find node.exe"), your own "command not found" / "module not found" errors (check system before reporting failure), and proactively when you need to locate a file to complete a task. NOT for project-local searches (use Glob/Grep) or file content search (use Grep).
---

# everything-find

Use **Everything** (voidtools) on Windows for near-instant file and directory lookup. Everything maintains a real-time index of the entire NTFS filesystem, so searches complete in 1–2 seconds instead of the 60+ seconds `find` or Explorer search takes.

## How it works

- `es.exe` — the CLI search tool. Returns results to the terminal.
- `everything.exe` — the background index service. Must be running for searches to work.
- Both binaries are bundled in the `scripts/` subdirectory of this skill folder.

## Quick Start

1. **Verify the binaries are present** in the `scripts/` directory. If missing, download the Everything portable package and ES CLI from <https://www.voidtools.com/downloads/>.
2. **Start `everything.exe`** (one-time, runs silently in the background). It's safe — no GUI needed, minimal resource usage.
3. **Run searches** with `es.exe`. The index is live; new files may take a few seconds to appear.

## Common Search Patterns

| Goal | Command |
|------|---------|
| Find by name | `es.exe <keyword>` |
| Files only | `es.exe <keyword> -a-d` |
| Directories only | `es.exe <keyword> -ad` |
| Limit results | `es.exe <keyword> -n 20` |
| Case-sensitive | `es.exe -i <keyword>` |
| Regex match | `es.exe -r "<pattern>"` |
| Path-scoped | `es.exe <keyword> -path "C:\Users"` |
| Whole-word match | `es.exe -w <keyword>` |

The results include the full path of each match. For long result lists, pipe through `find` or `Select-String` to filter further.

## Dependency & Tool Location

A common use case on Windows is locating installed runtimes and tools. Use the patterns below:

| Goal | Command |
|------|---------|
| Find an executable | `es.exe <name>.exe -a-d` |
| Find Python installation | `es.exe python.exe -a-d` |
| Find npm/node | `es.exe node.exe -a-d` or `es.exe npm -a-d` |
| Find a specific package dir | `es.exe <pkg-name> -ad -path "C:\Users\<user>" -n 10` |
| Find SDK root | `es.exe <sdk-name> -ad -n 5` |

When the user says "I'm missing X" or "can't find Y", first use es.exe to check if Y exists anywhere on the system before assuming it's not installed. The indexed search completes in 1–2 seconds, making it the fastest way to verify installation.

**Self-trigger on errors**: When you encounter your own execution errors — "command not found", "module not found", "'xxx' is not recognized", etc. — do not immediately report failure. Run an es.exe search first to locate the missing tool. If found, report the path. If not found, you can give a definitive answer with installation suggestions.

**Proactive search**: When a user asks you to "run", "open", "read", "execute", or "show" something by name but doesn't give a full path, use es.exe to find it before asking for clarification. Example: user says "run data_analysis.py" — search for data_analysis.py on the system first; you might find it under `C:\Users\...\projects\` and save a round trip.

## Error Handling

| Exit Code | Meaning | Action |
|-----------|---------|--------|
| 0 | Success | Return results to user |
| 8 | Everything not running | Start `everything.exe` silently, then retry |
| Other | Error | Show error details and stop |

## Presenting Results

- Show the user a clear summary: "Found N results for `<keyword>`"
- List the most relevant results first (use `-n` to cap long lists)
- For user-facing file paths, trim common prefixes or highlight the filename
- When zero results are found, suggest trying a broader keyword or checking the index is up to date

## When NOT to use

- **Current project directory**: Use Glob or Grep instead — they work within the working tree and don't need an index
- **File content search**: Use Grep — `es.exe` can search file names only, not content
- **One-off `ls` equivalent**: Just use `Get-ChildItem` / `dir`
