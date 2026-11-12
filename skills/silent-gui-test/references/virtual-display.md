# Virtual display for tests

## usbmmidd_v2 (recommended)

Amyuni's Indirect Display Driver. The `.cat` is signed by *Microsoft Windows Hardware
Compatibility Publisher*, so it installs without test signing or a reboot.

```
usbmmidd_v2/
  deviceinstaller64.exe   usbmmIdd.inf   usbmmidd.cat   usbmmIdd.dll
```

```powershell
$vdd = "$env:LOCALAPPDATA\app-probe\vdd"     # keep it, `enableidd` lives here
.\deviceinstaller64.exe install usbmmIdd.inf usbmmidd   # once, elevated
.\deviceinstaller64.exe enableidd 1                     # one monitor, up to 4
.\deviceinstaller64.exe enableidd 0                     # remove every added monitor
.\deviceinstaller64.exe stop usbmmidd                   # uninstall
.\deviceinstaller64.exe remove usbmmidd
```

Verify before trusting it:

```powershell
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { "$($_.DeviceName) $($_.Bounds) primary=$($_.Primary)" }
Get-PnpDevice -Class Display | Where-Object { $_.InstanceId -like 'ROOT\DISPLAY\*' }
```

The new monitor lands to the right of the primary and joins the virtual screen, so the
cursor can reach it. That is the point: the window is on a real screen, and the user is
looking at another one.

### Resolution

The driver offers the modes listed in
`HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\WUDF\Services\usbmmIdd\Parameters\Monitors`
(values `0`-`9`, `(Default)` picks the first-boot mode). Windows may still activate a
different mode from the stored config; read the active size from `Screen.AllScreens`
instead of assuming.

Match the test monitor to the primary resolution whenever the software under test sizes
anything from the monitor: a window that opens at 40% of the screen opens at 40% of
*this* screen, which turns every absolute size assertion into a failure. Either match the
sizes, or assert the change (it grew) rather than the number.

## Other drivers

| Driver | Note |
| --- | --- |
| Parsec VDD (`winget install Parsec.ParsecVDD`) | Installs the adapter, but creates no monitor until the Parsec app drives it. Verified inert standalone. |
| Amazon DCV Virtual Display | Same on-demand model, tied to DCV. |
| VirtualDrivers.Virtual-Display-Driver (MIT) | Creates monitors, ships a control app; needs a manual driver install. |
| An IDD that is already installed | Usually inert until its companion program asks for a monitor. Check `Get-PnpDevice -Class Display` and `Screen.AllScreens` before installing anything. |

## Cursor clamping

`SetCursorPos` clamps to the virtual screen. A window outside every monitor (`-12000,-12000`)
can therefore never be clicked or dragged by the physical pointer, and a posted click is
all it can receive. Off-screen placement removes the visual intrusion, not the input
problem; a virtual monitor removes both.

## Mixed DPI

A 100% virtual monitor next to a 125% primary gives the test window a different scale
factor than the app expects. Window bounds are logical pixels, Win32 rectangles are
physical. Convert with `GetDpiForWindow/96` and keep a single unit per assertion.
