---
name: silent-gui-test
description: Automated testing of desktop GUI applications must occur on a virtual screen, without occupying the user's desktop. Use this when: the user requests UI tests, screenshots, or automated clicks and requires that their normal computer use not be affected; test windows pop up in front of the user, steal focus, or steal the mouse; a virtual screen needs to be set up for unattended testing. When the task itself is desktop GUI development and requires running or taking screenshots of windows the user wrote, proactively ask the user whether they want to enable virtual-screen silent testing—do not open windows on the user's desktop right away.
metadata:
  version: "1.0"
---

# Automated testing happens only inside a virtual screen

The screen, focus, and cursor belong to the user, not to the test. So there is only one rule:

> **Every automated GUI test happens on a virtual screen. No test window appears on the user's desktop, takes focus, or moves the cursor.**

Without a virtual screen, build one first, then talk about testing. Test cases that cannot satisfy this sentence should be marked `SKIP` rather than run on the user's desktop.

## Three corollaries

1. **A virtual screen is a prerequisite, not an optimization.** What corresponds to a "headless browser" is "a monitor no one is watching", not "hiding the window".
2. **Windows must land on the virtual screen at creation time.** Creating first and moving later will flash, and may trigger cross-screen events that cause framework re-entry.
3. **When a virtual screen is unavailable, there are only two fallbacks:** place the window at coordinates outside all monitors, or do not run the test case at all. The boundary for the latter is described in `references/virtual-display.md`.

## Four checks

Go through existing tests one by one. Only when all four pass is a test compliant.

| Check | Violating pattern | Compliant pattern |
| --- | --- | --- |
| Does not take focus | `SW_SHOW`, `SW_RESTORE`, `SetForegroundWindow`, `activate()` | `SW_SHOWNOACTIVATE`, `SWP_NOACTIVATE`, `WS_EX_NOACTIVATE`; activation calls become no-ops under the test switch |
| Does not move the cursor | `SendInput`, `SetCursorPos`, `mouse_event` | Post messages to the window queue (see below); for steps that truly must move the physical pointer, wait until the system is idle, then borrow and restore it |
| Does not occupy the screen | Window lands on the primary monitor | Specify the virtual screen display at creation time; when no virtual screen exists, use coordinates outside the monitors |
| Does not pollute the taskbar | Test window appears in the taskbar | Check and remove `WS_EX_APPWINDOW`, or accept that it appears only on the virtual screen |

One more note: `-WindowStyle Hidden` and `visible=false` only affect the console and the first frame; the application's own `ShowWindow` will override them. They are not a substitute for "not showing".

## Platform-level pitfalls

These are unrelated to the framework; anything built on top of Win32 will hit them.

- **Coordinate semantics differ.** Mouse movement, button down, and button up use **client-area coordinates**; wheel messages use **screen coordinates**, with the delta in the high word. Mixing them yields a string of "clicked but nothing happened".
- **Modal loops only accept real input.** System-level window-drag/menu loops read the real cursor and real key state. Posted messages cannot drive them, and they also require a foreground window. For such steps, either obtain separate authorization to borrow the cursor, or change them to drag implemented inside the application.
- **Cross-screen movement is not free.** Moving a window triggers cross-screen events. Some frameworks rebuild display state inside those events; if this happens while still inside the creation call stack, it will re-enter and crash. Final placement must be done in the creation parameters.
- **Screenshots should rely on the window, not the screen.** `PrintWindow` reads the window (works even when occluded, minimized, or moved off-screen); screen capture reads the display (the window must be brought on-screen, so it cannot be used). When the window's own rendering fails, fall back to the application's own snapshot export.
- **Console encoding.** On non-UTF-8 code pages, PowerShell decodes child process output using the local encoding; UTF-8 JSON gets corrupted and all Chinese assertions fail falsely. Set UTF-8 uniformly at the test entry point.

## Turn the rules into assertions

If they are not written as assertions, the next refactor will bring the intrusion back.

| Assertion | Approach |
| --- | --- |
| Foreground window unchanged | Compare `GetForegroundWindow()` before and after each step |
| Cursor did not move | Compare `GetCursorPos()` before and after each step |
| Window is on the virtual screen | Compare the window rectangle with the virtual screen work area |
| Taskbar behaves as expected | Check the `WS_EX_APPWINDOW` / `WS_EX_TOOLWINDOW` bits |

Any failure is a test failure, not an "environment issue".

## Virtual screen

How to add one, how to turn it on and off, how to set the resolution, and the boundaries of cursor and DPI on this screen are all covered in `references/virtual-display.md`. This document only states the rules; that document covers the implementation.

## Files

| Path | Contents |
| --- | --- |
| `scripts/silent-probe.ps1` | A general-purpose tool implementing the four checks above: find a window, show it quietly, post input, capture by window, move to the virtual screen, and assert no intrusion. |
| `references/virtual-display.md` | Establishing and verifying the virtual screen. |

Minimal usage:

```powershell
. .\scripts\silent-probe.ps1
$before = Get-IntrusionSnapshot
$p = Start-Process .\app.exe -WindowStyle Hidden -PassThru
$w = Wait-ProbeWindow -ProcessId $p.Id -Title 'My App'
Set-QuietWindow $w.Handle
Move-ToTestMonitor $w.Handle
Invoke-QuietClick $w.Handle 40 30
Save-WindowImage $w.Handle 'shot.png' -ClientOnly
Assert-NoIntrusion $before
```
