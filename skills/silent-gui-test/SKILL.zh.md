---
name: silent-gui-test
description: 对桌面 GUI 应用程序进行自动化测试时，必须在一块虚拟屏幕上进行，不得占用用户桌面。适用于以下情况：用户请求进行 UI 测试、截图或自动化点击，并要求不影响其正常使用电脑；测试窗口会弹到用户面前、抢占焦点或抢占鼠标；需要为无人值守测试搭建一块虚拟屏幕。当任务本身就是桌面 GUI 开发，并且需要运行或截取用户编写的窗口时，应主动询问用户是否要启用虚拟屏幕静默测试——不要立刻在用户桌面上打开窗口。
metadata:
  version: "1.0"
---

# 自动化测试只发生在虚拟屏幕里

屏幕、焦点和光标是用户的东西，不是测试的东西。所以规则只有一句：

> **每一次自动化 GUI 测试都发生在虚拟屏幕中，用户桌面上不出现任何测试窗口、不吃焦点、不动光标。**

没有虚拟屏幕，就先建一块，再谈测试。做不到这句话的用例，宁可标 `SKIP`，也不要放到用户的桌面上跑。

## 三条推论

1. **虚拟屏幕是前提，不是优化。** 和"headless 浏览器"对应的是"一块没人看的显示器"，不是"把窗口藏起来"。
2. **窗口在创建时就落在虚拟屏幕上。** 先创建再搬，会闪一下，还可能触发跨屏事件导致框架重入。
3. **拿不到虚拟屏幕时，退而求其次只有两种**：窗口放到所有显示器之外的坐标，或者干脆不跑这个用例。后者的边界见 `references/virtual-display.md`。

## 四项检查

对着现有测试逐条过，全中才算合规。

| 检查 | 违规写法 | 合规写法 |
| --- | --- | --- |
| 不吃焦点 | `SW_SHOW`、`SW_RESTORE`、`SetForegroundWindow`、`activate()` | `SW_SHOWNOACTIVATE`、`SWP_NOACTIVATE`、`WS_EX_NOACTIVATE`，激活调用在测试开关下变成空操作 |
| 不动光标 | `SendInput`、`SetCursorPos`、`mouse_event` | 往窗口队列投递消息（见下）；确实必须动物理指针的步骤，等系统空闲后再借用并还原 |
| 不占屏幕 | 窗口落在主显示器上 | 创建时指定虚拟屏幕的 display；没有虚拟屏幕时用显示器之外的坐标 |
| 不污染任务栏 | 测试窗口出现在任务栏 | 检查并去掉 `WS_EX_APPWINDOW`，或接受它只出现在虚拟屏幕上 |

顺手记一条：`-WindowStyle Hidden`、`visible=false` 只影响控制台和最初一帧，应用自己的 `ShowWindow` 会把它推翻。它不是"不显示"的替代品。

## 平台层陷阱

这些和框架无关，任何 Win32 之上的东西都会踩。

- **坐标语义不同。** 鼠标移动、按下、抬起用**客户区坐标**；滚轮消息用**屏幕坐标**，增量在高位字。混了就是一串"点了没反应"。
- **模态循环只认真实输入。** 系统级的拖窗/菜单循环读的是真实光标和真实按键状态，投递的消息驱动不了它，它还需要一个前台窗口。这类步骤要么单独授权后借光标，要么改成应用内部实现拖拽。
- **跨屏移动不是免费的。** 移动窗口会触发跨屏事件，某些框架会在事件里重建显示状态，如果此时正处于创建调用的栈内，就会重入并崩溃。落位要在创建参数里完成。
- **截图要靠窗口，不靠屏幕。** `PrintWindow` 读窗口（遮挡、最小化、移出屏幕都能取），屏幕抓取读显示器（必须上台，用不了）。窗口自身渲染失败时，退回应用自己的快照导出。
- **控制台编码。** 非 UTF-8 代码页下，PowerShell 按本地编码解码子进程输出，UTF-8 的 JSON 会被解坏，中文断言全部假失败。在测试入口统一设成 UTF-8。

## 让规则变成断言

不写成断言，下一次重构就会把打扰带回来。

| 断言 | 做法 |
| --- | --- |
| 前台窗口没变 | 每步前后比较 `GetForegroundWindow()` |
| 光标没动 | 每步前后比较 `GetCursorPos()` |
| 窗口在虚拟屏幕上 | 比较窗口矩形与虚拟屏幕工作区 |
| 任务栏符合预期 | 检查 `WS_EX_APPWINDOW` / `WS_EX_TOOLWINDOW` 位 |

任何一条失败就是测试失败，不是"环境问题"。

## 虚拟屏幕

怎么加一块、怎么开关、分辨率怎么定、光标和 DPI 在这块屏上的边界，都在 `references/virtual-display.md`。本文只讲规则，那份讲实现。

## 文件

| 路径 | 内容 |
| --- | --- |
| `scripts/silent-probe.ps1` | 落地上面四项检查的通用工具：找窗口、安静显示、投递输入、按窗口截图、搬到虚拟屏幕、空隙断言。 |
| `references/virtual-display.md` | 虚拟屏幕的建立与验证。 |

最小用法：

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
