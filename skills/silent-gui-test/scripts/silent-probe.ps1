#Requires -Version 7
<#
Shared helpers for silent Windows GUI probes.

Dot-source it, then drive the app without taking the user's focus, pointer or screen:

    . .\scripts\silent-probe.ps1
    $p = Start-Process .\app.exe -WindowStyle Hidden -PassThru
    $h = Wait-ProbeWindow -ProcessId $p.Id -Title 'My App'
    Show-Quiet $h
    Invoke-QuietClick $h 60 60
    Save-WindowImage $h 'window.png' -ClientOnly
    Assert-NoIntrusion $foreground $cursor

Everything here posts input into the window queue, so the physical pointer never
moves, except Invoke-QuietDrag, which borrows it after the machine has been idle
and always puts it back.
#>

Add-Type -AssemblyName System.Drawing

if (!('SilentProbe' -as [type])) {
    Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class SilentProbe {
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    public delegate bool MonitorProc(IntPtr h, IntPtr dc, IntPtr rect, IntPtr data);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int index);
    [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int index, IntPtr value);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out Rect r);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref Point p);
    [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref Point p);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point p);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point p);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LastInputInfo info);
    [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorProc cb, IntPtr data);
    [DllImport("user32.dll")] public static extern bool GetMonitorInfoW(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll", EntryPoint="PostMessageW")] public static extern bool Post(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] input, int size);

    public struct Rect { public int Left, Top, Right, Bottom; }
    public struct Point { public int X, Y; }
    public struct LastInputInfo { public uint cbSize; public uint dwTime; }
    [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo {
        public uint cbSize; public Rect monitor; public Rect work; public uint flags;
    }
    [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public MouseInput Mouse; }

    const uint WM_MOUSEMOVE = 0x0200, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202;
    const uint WM_MOUSEWHEEL = 0x020A, WM_CHAR = 0x0102;
    const uint MK_LBUTTON = 0x0001;
    const uint SW_SHOWNOACTIVATE = 4;
    const int GWL_EXSTYLE = -20;
    const long WS_EX_NOACTIVATE = 0x08000000;
    const uint SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOZORDER = 0x0004;
    const uint SWP_NOACTIVATE = 0x0010, SWP_FRAMECHANGED = 0x0020, SWP_SHOWWINDOW = 0x0040;
    const uint MONITORINFOF_PRIMARY = 1;

    static IntPtr Pack(int x, int y) {
        return new IntPtr((x & 0xffff) | ((y & 0xffff) << 16));
    }

    /// Shows a window - and un-minimizes it - without activating it.
    public static void ShowQuiet(IntPtr h) { ShowWindow(h, (int)SW_SHOWNOACTIVATE); }

    /// Makes a window permanently unable to take the foreground.
    public static void Quiet(IntPtr h) {
        long style = GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64();
        if ((style & WS_EX_NOACTIVATE) == 0)
            SetWindowLongPtr(h, GWL_EXSTYLE, new IntPtr(style | WS_EX_NOACTIVATE));
        SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0,
            SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER);
    }

    public static bool IsQuiet(IntPtr h) {
        return (GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64() & WS_EX_NOACTIVATE) != 0;
    }

    public static bool IsTaskbarWindow(IntPtr h) {
        return (GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64() & 0x40000) != 0;
    }

    /// System-wide milliseconds since the last keyboard or pointer input.
    public static uint IdleMilliseconds() {
        var info = new LastInputInfo { cbSize = (uint)Marshal.SizeOf(typeof(LastInputInfo)) };
        if (!GetLastInputInfo(ref info)) return 0;
        return unchecked((uint)Environment.TickCount - info.dwTime);
    }

    /// Posted click in client coordinates; the physical pointer never moves.
    public static void Click(IntPtr h, int x, int y) {
        Post(h, WM_MOUSEMOVE, IntPtr.Zero, Pack(x, y));
        Post(h, WM_LBUTTONDOWN, new IntPtr(MK_LBUTTON), Pack(x, y));
        Post(h, WM_LBUTTONUP, IntPtr.Zero, Pack(x, y));
    }

    public static void DoubleClick(IntPtr h, int x, int y) {
        Click(h, x, y);
        Click(h, x, y);
    }

    /// Posted characters; the keyboard layout and the focus are untouched.
    public static void Type(IntPtr h, string text) {
        foreach (char c in text) Post(h, WM_CHAR, new IntPtr(c), IntPtr.Zero);
    }

    /// Posted wheel notch; WM_MOUSEWHEEL carries screen coordinates.
    public static void Wheel(IntPtr h, int x, int y, int delta) {
        var screen = new Point { X = x, Y = y };
        ClientToScreen(h, ref screen);
        Post(h, WM_MOUSEWHEEL, new IntPtr((delta & 0xffff) << 16), Pack(screen.X, screen.Y));
    }

    public static IntPtr Foreground() { return GetForegroundWindow(); }
    public static Point Cursor() { Point p; GetCursorPos(out p); return p; }
    public static Rect WindowRect(IntPtr h) { Rect r; GetWindowRect(h, out r); return r; }
    public static Rect ClientArea(IntPtr h) { Rect r; GetClientRect(h, out r); return r; }
    public static double Scale(IntPtr h) { return GetDpiForWindow(h) / 96.0; }

    /// Drags from client (x,y) by (dx,dy) and returns the new window rect.
    ///
    /// A native modal move loop reads the real pointer and the real button state, so
    /// no posted message can drive it. Wait for an idle machine, borrow the pointer,
    /// then put the cursor and the foreground back.
    public static Rect Drag(IntPtr h, uint expectedOwner, int x, int y, int dx, int dy) {
        uint owner; GetWindowThreadProcessId(h, out owner);
        if (owner != expectedOwner) throw new InvalidOperationException("Refusing to drag a different process");
        for (int waited = 0; IdleMilliseconds() < 700; waited += 100) {
            if (waited >= 5000) throw new InvalidOperationException("Machine in use; refusing to take the pointer");
            System.Threading.Thread.Sleep(100);
        }
        Point oldCursor; GetCursorPos(out oldCursor);
        IntPtr previous = GetForegroundWindow();
        bool wasTopmost = (GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64() & 0x8) != 0;
        bool down = false;
        try {
            ShowQuiet(h);
            // Raise without activating so the pointer lands on this window.
            SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
            System.Threading.Thread.Sleep(150);
            var start = new Point { X = x, Y = y };
            ClientToScreen(h, ref start);
            SetCursorPos(start.X, start.Y);
            System.Threading.Thread.Sleep(100);
            if (GetAncestor(WindowFromPoint(start), 2) != h)
                throw new InvalidOperationException("The pointer is not over the window under test");
            Press(true); down = true;
            System.Threading.Thread.Sleep(100);
            for (int step = 1; step <= 8; step++) {
                SetCursorPos(start.X + dx * step / 8, start.Y + dy * step / 8);
                System.Threading.Thread.Sleep(60);
            }
            Press(false); down = false;
            System.Threading.Thread.Sleep(150);
            return WindowRect(h);
        } finally {
            if (down) Press(false);
            SetCursorPos(oldCursor.X, oldCursor.Y);
            if (IsWindow(h))
                SetWindowPos(h, new IntPtr(wasTopmost ? -1 : -2), 0, 0, 0, 0,
                    SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
            if (previous != IntPtr.Zero) SetForegroundWindow(previous);
        }
    }

    static void Press(bool down) {
        var input = new Input { Type = 0, Mouse = new MouseInput { Flags = down ? 0x0002u : 0x0004u } };
        if (SendInput(1, new[] { input }, Marshal.SizeOf(typeof(Input))) != 1)
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }

    /// Work areas of every monitor, primary first, left to right.
    public static Rect[] WorkAreas() {
        var found = new List<Rect>();
        MonitorProc cb = (monitor, dc, rect, data) => {
            var info = new MonitorInfo { cbSize = (uint)Marshal.SizeOf(typeof(MonitorInfo)) };
            if (GetMonitorInfoW(monitor, ref info)) {
                if (info.flags == MONITORINFOF_PRIMARY) found.Insert(0, info.work);
                else found.Add(info.work);
            }
            return true;
        };
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, cb, IntPtr.Zero);
        return found.ToArray();
    }

    /// Moves a window onto the first monitor that is not the primary one, keeping its
    /// size and clamping it inside that monitor's work area. Returns false when there
    /// is no second monitor.
    public static bool MoveToNonPrimary(IntPtr h) {
        var areas = WorkAreas();
        if (areas.Length < 2) return false;
        Rect target = areas[1];
        Rect current; GetWindowRect(h, out current);
        int width = current.Right - current.Left, height = current.Bottom - current.Top;
        int x = Math.Clamp(current.Left, target.Left, Math.Max(target.Left, target.Right - width));
        int y = Math.Clamp(current.Top, target.Top, Math.Max(target.Top, target.Bottom - height));
        SetWindowPos(h, IntPtr.Zero, x, y, 0, 0, SWP_NOACTIVATE | SWP_NOSIZE | SWP_NOZORDER);
        return true;
    }

    /// Captures a window with PrintWindow, which reads the window and not the screen,
    /// so it works occluded, minimized or off-screen.
    public static bool CaptureTo(IntPtr h, IntPtr hdc, bool clientOnly) {
        return PrintWindow(h, hdc, clientOnly ? 3u : 2u);
    }

    public static string Describe(IntPtr h) {
        var title = new StringBuilder(512);
        GetWindowTextW(h, title, 512);
        Rect r = WindowRect(h);
        return string.Format("'{0}' at {1},{2} {3}x{4} quiet={5}",
            title, r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top, IsQuiet(h));
    }
}
'@
}

<#
    Window discovery: filter by owning process, never by a fixed sleep.
#>
function Get-ProbeWindow {
    param(
        [Parameter(Mandatory)][int]$ProcessId,
        [string]$Title,
        [string]$ClassName
    )
    $found = [System.Collections.Generic.List[object]]::new()
    $cb = [SilentProbe+EnumProc] {
        param($h, $p)
        $owner = 0
        [void][SilentProbe]::GetWindowThreadProcessId($h, [ref]$owner)
        if ($owner -eq $ProcessId) {
            $text = [System.Text.StringBuilder]::new(512)
            [void][SilentProbe]::GetWindowTextW($h, $text, 512)
            $class = [System.Text.StringBuilder]::new(256)
            [void][SilentProbe]::GetClassNameW($h, $class, 256)
            if ((!$Title -or $text.ToString() -eq $Title) -and (!$ClassName -or $class.ToString() -eq $ClassName)) {
                $found.Add([pscustomobject]@{ Handle = $h; Title = $text.ToString(); Class = $class.ToString() })
            }
        }
        return $true
    }
    [void][SilentProbe]::EnumWindows($cb, [IntPtr]::Zero)
    return $found.ToArray()
}

function Wait-ProbeWindow {
    param(
        [Parameter(Mandatory)][int]$ProcessId,
        [string]$Title,
        [int]$TimeoutSeconds = 20
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $window = @(Get-ProbeWindow -ProcessId $ProcessId -Title $Title)
        if ($window.Count -ge 1) { return $window[0] }
        Start-Sleep -Milliseconds 200
    } until ([DateTime]::UtcNow -gt $deadline)
    throw "No window for process $ProcessId with title '$Title'"
}

function Show-Quiet([IntPtr]$Handle) { [SilentProbe]::ShowQuiet($Handle) }
function Set-QuietWindow([IntPtr]$Handle) { [SilentProbe]::Quiet($Handle) }

function Invoke-QuietClick([IntPtr]$Handle, [int]$X, [int]$Y) {
    Show-Quiet $Handle
    $scale = [SilentProbe]::Scale($Handle)
    [SilentProbe]::Click($Handle, [int]($X * $scale), [int]($Y * $scale))
}

function Invoke-QuietDoubleClick([IntPtr]$Handle, [int]$X, [int]$Y) {
    Show-Quiet $Handle
    $scale = [SilentProbe]::Scale($Handle)
    [SilentProbe]::DoubleClick($Handle, [int]($X * $scale), [int]($Y * $scale))
}

function Send-QuietText([IntPtr]$Handle, [string]$Text) { [SilentProbe]::Type($Handle, $Text) }

function Invoke-QuietWheel([IntPtr]$Handle, [int]$X, [int]$Y, [int]$Delta) {
    $scale = [SilentProbe]::Scale($Handle)
    [SilentProbe]::Wheel($Handle, [int]($X * $scale), [int]($Y * $scale), $Delta)
}

function Invoke-QuietDrag([IntPtr]$Handle, [int]$ProcessId, [int]$X, [int]$Y, [int]$Dx, [int]$Dy) {
    $scale = [SilentProbe]::Scale($Handle)
    [SilentProbe]::Drag($Handle, [uint32]$ProcessId, [int]($X * $scale), [int]($Y * $scale), [int]($Dx * $scale), [int]($Dy * $scale))
}

function Save-WindowImage {
    param([IntPtr]$Handle, [string]$Path, [switch]$ClientOnly)
    $rect = if ($ClientOnly) { [SilentProbe]::ClientArea($Handle) } else { [SilentProbe]::WindowRect($Handle) }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -le 0 -or $height -le 0) { throw 'Window has no area to capture' }
    $image = [System.Drawing.Bitmap]::new($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($image)
    $dc = $graphics.GetHdc()
    try { $ok = [SilentProbe]::CaptureTo($Handle, $dc, $ClientOnly.IsPresent) }
    finally { $graphics.ReleaseHdc($dc) }
    try {
        if (!$ok) { throw "PrintWindow failed for $Path" }
        $image.Save($Path)
    } finally { $graphics.Dispose(); $image.Dispose() }
    return $Path
}

function Get-IntrusionSnapshot {
    $cursor = [SilentProbe]::Cursor()
    [pscustomobject]@{ Foreground = [SilentProbe]::Foreground(); CursorX = $cursor.X; CursorY = $cursor.Y }
}

function Assert-NoIntrusion {
    param(
        [Parameter(Mandatory)]$Before,
        [int]$ProcessId = 0
    )
    $after = Get-IntrusionSnapshot
    if ($after.Foreground -ne $Before.Foreground) {
        $owner = 0
        [void][SilentProbe]::GetWindowThreadProcessId($after.Foreground, [ref]$owner)
        throw "Focus moved to another window (owner process $owner) during the check"
    }
    if ($after.CursorX -ne $Before.CursorX -or $after.CursorY -ne $Before.CursorY) {
        throw "The pointer moved from $($Before.CursorX),$($Before.CursorY) to $($after.CursorX),$($after.CursorY)"
    }
    return $true
}

function Move-ToTestMonitor([IntPtr]$Handle) { [SilentProbe]::MoveToNonPrimary($Handle) }

function Get-TestMonitorPresent { ([SilentProbe]::WorkAreas()).Length -gt 1 }
