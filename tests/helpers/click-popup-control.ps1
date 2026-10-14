# Windows desktop regression helper: clicks only the specified visible, uncovered popup.
param([long]$WindowHandle,[double]$CssX,[double]$CssY,[double]$CssWidth)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PopupMouse {
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int L; public int T; public int R; public int B; }
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
 [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window,out Rect rect);
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window,ref Point point);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window,uint flags);
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
}
"@
[PopupMouse]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null
$popupHandle = [IntPtr]$WindowHandle
if(-not [PopupMouse]::IsWindowVisible($popupHandle)){throw 'Popup not visible before mouse click'}
$popupRect = New-Object PopupMouse+Rect
$popupOrigin = New-Object PopupMouse+Point
$originalCursor = New-Object PopupMouse+Point
if(-not [PopupMouse]::GetClientRect($popupHandle,[ref]$popupRect)){throw 'Cannot read popup dimensions'}
if(-not [PopupMouse]::ClientToScreen($popupHandle,[ref]$popupOrigin)){throw 'Cannot locate popup'}
[PopupMouse]::GetCursorPos([ref]$originalCursor) | Out-Null
$popupScale = ($popupRect.R - $popupRect.L) / $CssWidth
$targetX = [int]($popupOrigin.X + $CssX * $popupScale)
$targetY = [int]($popupOrigin.Y + $CssY * $popupScale)
if($CssX -lt 0 -or $CssX -gt $CssWidth -or $CssY -lt 0 -or $CssY * $popupScale -gt $popupRect.B){throw 'Click is outside popup'}
$targetPoint = New-Object PopupMouse+Point
$targetPoint.X = $targetX; $targetPoint.Y = $targetY
if([PopupMouse]::GetAncestor([PopupMouse]::WindowFromPoint($targetPoint),2) -ne $popupHandle){throw "Popup is covered; refusing click"}
try {
 [PopupMouse]::SetCursorPos($targetX,$targetY) | Out-Null
 [PopupMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
 [PopupMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
} finally { [PopupMouse]::SetCursorPos($originalCursor.X,$originalCursor.Y) | Out-Null }
